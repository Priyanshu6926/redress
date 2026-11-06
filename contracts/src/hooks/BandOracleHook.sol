// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Gives any v4 pool a price band: a time-weighted tick plus the lowest and highest
/// ticks seen over a window, so a market can read an independent band with no external oracle.
/// @dev Records the pool's tick before the first swap of each block. That tick is where the
/// previous block ended, so a swap cannot move the observation for its own block, and only
/// the first swap of a block writes. A manipulator must hold a price across a block boundary,
/// and the band's min and max then show it.
///
/// Limits: the pool only records when it trades, so a quiet pool gives a stale band, which
/// `count` and `lastObservedAt` expose. Observations live in a ring, so a window longer than
/// the ring's history is served from what remains, reported through `coveredSeconds`.
///
/// BaseHook comes from OpenZeppelin uniswap-hooks, as in Uniswap's v4-template. It left
/// v4-periphery in commit 5da22e60.
contract BandOracleHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint16 public constant CARDINALITY = 1024;

    struct Observation {
        uint32 timestamp;
        int24 tick;
        int56 tickCumulative; // sum of tick * seconds up to timestamp, as in Uniswap v3
    }

    struct Band {
        int24 twapTick;
        int24 minTick;
        int24 maxTick;
        uint32 count;
        uint32 coveredSeconds;
        uint32 lastObservedAt;
    }

    error UnknownPool();
    error ZeroWindow();

    event ObservationRecorded(PoolId indexed poolId, uint32 timestamp, int24 tick);

    mapping(PoolId poolId => Observation[1024] ring) private observations;
    mapping(PoolId poolId => uint16 newest) private newestIndex;
    mapping(PoolId poolId => uint16 stored) private storedCount;

    constructor(IPoolManager manager) BaseHook(manager) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.afterInitialize = true;
        permissions.beforeSwap = true;
    }

    function observationCount(PoolKey calldata key) external view returns (uint16) {
        return storedCount[key.toId()];
    }

    /// @notice The band over the last `window` seconds, ending now.
    function getBand(PoolKey calldata key, uint32 window) external view returns (Band memory band) {
        if (window == 0) revert ZeroWindow();
        PoolId id = key.toId();
        uint16 stored = storedCount[id];
        if (stored == 0) revert UnknownPool();

        Observation[1024] storage ring = observations[id];
        uint16 index = newestIndex[id];
        Observation memory newest = ring[index];
        uint32 nowTs = uint32(block.timestamp);
        uint32 cutoff = nowTs > window ? nowTs - window : 0;

        // A swap in this block has already recorded, so spot is only read when no swap has
        // happened in this block, when it is the price an earlier block ended on.
        int24 tickNow = newest.tick;
        if (nowTs > newest.timestamp) (, tickNow,,) = poolManager.getSlot0(id);

        // `later` is the observation after the one being read: its tick held since that one.
        Observation memory later = Observation(nowTs, tickNow, _accumulate(newest, tickNow, nowTs));
        int56 endCumulative = later.tickCumulative;
        int56 startCumulative = endCumulative;
        uint32 startTs = nowTs;

        band.minTick = tickNow;
        band.maxTick = tickNow;
        band.lastObservedAt = newest.timestamp;

        for (uint16 i = 0; i < stored; i++) {
            Observation memory o = ring[(uint256(index) + CARDINALITY - i) % CARDINALITY];
            if (o.timestamp <= cutoff) {
                startTs = cutoff;
                startCumulative = _accumulate(o, later.tick, cutoff);
                break;
            }
            if (o.tick < band.minTick) band.minTick = o.tick;
            if (o.tick > band.maxTick) band.maxTick = o.tick;
            band.count++;
            startTs = o.timestamp;
            startCumulative = o.tickCumulative;
            later = o;
        }

        band.coveredSeconds = nowTs - startTs;
        band.twapTick = band.coveredSeconds == 0
            ? tickNow
            : _floorDiv(endCumulative - startCumulative, int56(uint56(band.coveredSeconds)));
    }

    function _afterInitialize(address, PoolKey calldata key, uint160, int24 tick) internal override returns (bytes4) {
        PoolId id = key.toId();
        observations[id][0] = Observation(uint32(block.timestamp), tick, 0);
        storedCount[id] = 1;
        emit ObservationRecorded(id, uint32(block.timestamp), tick);
        return this.afterInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _record(key.toId());
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _record(PoolId id) private {
        uint16 index = newestIndex[id];
        Observation memory last = observations[id][index];
        uint32 nowTs = uint32(block.timestamp);
        if (last.timestamp == nowTs) return;

        (, int24 tick,,) = poolManager.getSlot0(id);
        uint16 next = (index + 1) % CARDINALITY;
        observations[id][next] = Observation(nowTs, tick, _accumulate(last, tick, nowTs));
        newestIndex[id] = next;
        if (storedCount[id] < CARDINALITY) storedCount[id]++;
        emit ObservationRecorded(id, nowTs, tick);
    }

    /// The tick read at an observation is the one that held since the previous observation.
    function _accumulate(Observation memory from, int24 tick, uint32 to) private pure returns (int56) {
        return from.tickCumulative + int56(tick) * int56(uint56(to - from.timestamp));
    }

    /// Rounds toward negative infinity, as Uniswap's own TWAP does.
    function _floorDiv(int56 a, int56 b) private pure returns (int24) {
        int56 q = a / b;
        if (a < 0 && a % b != 0) q--;
        return int24(q);
    }
}
