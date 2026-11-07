// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Wrapped SepoliaETH for the live demo. Every token is backed 1:1 by real test ETH.
/// @dev A transfer from a marked sender, such as the vault, arrives as native ETH, so a payout
/// raises the victim's wallet balance directly. Marking is a demo convenience, not a pattern to
/// copy: it hands control to the recipient, which the vault's reentrancy guard covers here.
contract DemoWETH is ERC20 {
    error OnlyOwner();
    error EthTransferFailed();

    address public immutable owner;
    mapping(address sender => bool unwraps) public autoUnwrap;

    constructor() ERC20("Redress Demo WETH", "rdWETH") {
        owner = msg.sender;
    }

    function setAutoUnwrap(address sender) external {
        if (msg.sender != owner) revert OnlyOwner();
        autoUnwrap[sender] = true;
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (!autoUnwrap[msg.sender]) return super.transfer(to, amount);
        _burn(msg.sender, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        return true;
    }
}
