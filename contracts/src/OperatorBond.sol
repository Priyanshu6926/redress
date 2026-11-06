// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title OperatorBond
 * @notice Oracle risk service providers post bonds against specific adapters.
 * Slashed first in the waterfall when an oracle misconfiguration occurs.
 */
contract OperatorBond {
    address public immutable owner;
    address public redressVault;

    mapping(address => mapping(address => uint256)) public bonds; // operator => adapter => amount

    event BondDeposited(address indexed operator, address indexed adapter, uint256 amount);
    event BondSlashed(address indexed operator, address indexed adapter, uint256 amount, address recipient);

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

    function depositBond(address adapter) external payable {
        bonds[msg.sender][adapter] += msg.value;
        emit BondDeposited(msg.sender, adapter, msg.value);
    }

    function slash(
        address operator,
        address adapter,
        uint256 amount,
        address payable recipient
    ) external onlyVault returns (uint256 slashed) {
        uint256 available = bonds[operator][adapter];
        slashed = amount > available ? available : amount;
        if (slashed > 0) {
            bonds[operator][adapter] -= slashed;
            (bool success, ) = recipient.call{value: slashed}("");
            require(success, "Slash payout failed");
            emit BondSlashed(operator, adapter, slashed, recipient);
        }
    }
}

