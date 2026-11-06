// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BandOracleHook
 * @notice Uniswap v4 hook that records tick observations and exposes a native price band
 * (twapTick, minTick, maxTick, observationCount) for manipulation resistance without external dependencies.
 */
contract BandOracleHook {
    struct Observation {
        uint32 timestamp;
        int24 tick;
    }

    struct ObservationBand {
        int24 twapTick;
        int24 minTick;
        int24 maxTick;
        uint32 count;
    }

    // PoolId => Observations
    mapping(bytes32 => Observation[]) public observations;

    event ObservationRecorded(bytes32 indexed poolId, uint32 timestamp, int24 tick);

    function recordObservation(bytes32 poolId, int24 currentTick) external {
        observations[poolId].push(Observation({
            timestamp: uint32(block.timestamp),
            tick: currentTick
        }));
        emit ObservationRecorded(poolId, uint32(block.timestamp), currentTick);
    }

    function getBand(bytes32 poolId, uint32 window) external view returns (
        int24 twapTick,
        int24 minTick,
        int24 maxTick,
        uint32 count
    ) {
        Observation[] storage obs = observations[poolId];
        uint256 len = obs.length;
        if (len == 0) return (0, 0, 0, 0);

        uint32 cutoff = uint32(block.timestamp) - window;
        int24 min = type(int24).max;
        int24 max = type(int24).min;
        int56 tickSum = 0;
        uint32 validCount = 0;

        for (uint256 i = len; i > 0; i--) {
            Observation memory o = obs[i - 1];
            if (o.timestamp < cutoff) break;

            if (o.tick < min) min = o.tick;
            if (o.tick > max) max = o.tick;
            tickSum += o.tick;
            validCount++;
        }

        if (validCount == 0) return (obs[len - 1].tick, obs[len - 1].tick, obs[len - 1].tick, 1);

        twapTick = int24(tickSum / int56(uint56(validCount)));
        minTick = min;
        maxTick = max;
        count = validCount;
    }
}

