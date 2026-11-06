// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

interface IForwarder {
    function report(address receiver, bytes calldata rawReport, bytes calldata reportContext, bytes[] calldata signatures)
        external;
}

contract RecordingReceiver {
    uint256 public calls;
    bytes public lastMetadata;
    bytes public lastReport;

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external {
        calls++;
        lastMetadata = metadata;
        lastReport = report;
    }
}

/// Measures whether MockKeystoneForwarder delivers a forged report from an arbitrary sender.
/// The result decides the trust model of any vault configured with it.
contract MockForwarderForkTest is Test {
    /// Ethereum Mainnet mock forwarder from the CRE forwarder directory.
    address private constant MOCK = 0xA3D1AD4Ac559a6575a114998AffB2fB2Ec97a7D9;

    function test_arbitrarySenderCanDeliverThroughTheMockForwarder() public {
        string memory rpc = vm.envOr("MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        RecordingReceiver receiver = new RecordingReceiver();
        bytes memory forgedPayload = abi.encode(uint256(42));
        // 109-byte header: version, execution id, timestamp, DON id, config version,
        // workflow id, name, owner, report id. All forged.
        bytes memory rawReport = abi.encodePacked(new bytes(109), forgedPayload);

        vm.prank(address(0xBAD));
        IForwarder(MOCK).report(address(receiver), rawReport, new bytes(0), new bytes[](0));

        assertEq(receiver.calls(), 1, "mock did not deliver");
        assertEq(receiver.lastReport(), forgedPayload);
    }
}
