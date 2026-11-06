// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RecoveryLedger
 * @notice Tracks claims against liquidators and block builders that benefited from wrongful liquidations.
 */
contract RecoveryLedger {
    address public immutable owner;
    address public redressVault;

    struct RecoveryClaim {
        bytes32 liquidationTx;
        address beneficiary; // liquidator or builder address
        uint256 expectedAmount;
        uint256 recoveredAmount;
        bool settled;
    }

    mapping(bytes32 => RecoveryClaim) public claims;

    event RecoveryClaimOpened(bytes32 indexed liquidationTx, address indexed beneficiary, uint256 expectedAmount);
    event RecoveryClaimSettled(bytes32 indexed liquidationTx, uint256 amount);

    modifier onlyVault() {
        require(msg.sender == redressVault, "Only RedressVault");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setVault(address _vault) external onlyOwner {
        redressVault = _vault;
    }

    function openClaim(
        bytes32 liquidationTx,
        address beneficiary,
        uint256 expectedAmount
    ) external onlyVault {
        claims[liquidationTx] = RecoveryClaim({
            liquidationTx: liquidationTx,
            beneficiary: beneficiary,
            expectedAmount: expectedAmount,
            recoveredAmount: 0,
            settled: false
        });
        emit RecoveryClaimOpened(liquidationTx, beneficiary, expectedAmount);
    }

    function recordRecovery(bytes32 liquidationTx, uint256 amount) external onlyVault {
        RecoveryClaim storage claim = claims[liquidationTx];
        claim.recoveredAmount += amount;
        if (claim.recoveredAmount >= claim.expectedAmount) {
            claim.settled = true;
        }
        emit RecoveryClaimSettled(liquidationTx, amount);
    }
}

