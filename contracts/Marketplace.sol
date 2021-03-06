// SPDX-License-Identifier: MIT

pragma solidity ^0.8.10;

import "./security/ReentrancyGuard.sol";
import "./token/ERC20/SafeERC20.sol";
import "./access/Ownable.sol";
import "./security/Pausable.sol";
import "./token/ACDMToken.sol";

/** @title ACDM marketplace. */
contract Marketplace is Ownable, ReentrancyGuard, Pausable {
  using SafeERC20 for IERC20;

  struct Order {
    uint256 amount;
    uint256 cost;       // eth tokenPrice * amount
    uint256 tokenPrice; // eth
    address account;
    bool isOpen;
  }

  struct Round {
    uint256 createdAt;
    uint256 endTime;
    uint256 tradeVolume; // eth
    uint256 tokensLeft;
    uint256 price;
  }

  /**
   * @dev Emitted when `account` registers it's `referrer`.
   */
  event UserRegistered(address indexed account, address indexed referrer);

  /**
   * @dev Emitted when `account` placing a sale order.
   */
  event PlacedOrder(uint256 indexed roundID, address indexed account, uint256 amount, uint256 cost);

  /**
   * @dev Emitted when `account` cancelling it's order.
   */
  event CancelledOrder(uint256 indexed roundID, uint256 indexed orderID, address indexed account);

  /**
   * @dev Emitted when `buyer` buying tokens in both sale or trade round.
   * On sale round `seller` is the Marketplace contract address.
   * On trade round `seller` is the order owner.
   */
  event TokenBuy(uint256 indexed roundID, address indexed buyer, address indexed seller, uint256 amount, uint256 price, uint256 cost);

  /**
   * @dev Emitted when a new sale round started.
   */
  event StartedSaleRound(uint256 indexed roundID, uint256 newPrice, uint256 oldPrice, uint256 minted);

  /**
   * @dev Emitted when a trade round is finished.
   */
  event FinishedSaleRound(uint256 indexed roundID, uint256 oldPrice, uint256 burned);

  /**
   * @dev Emitted when a new trade round started.
   */
  event StartedTradeRound(uint256 indexed roundID);

  /**
   * @dev Emitted when a trade round is finished.
   */
  event FinishedTradeRound(uint256 indexed roundID, uint256 tradeVolume);

  /**
   * @dev Emitted when admin withdraws ETH from Marketplace.
   */
  event Withdraw(address indexed to, uint256 amount);

  // Basis point.
  uint256 public constant BASIS_POINT = 10000;

  // Round duration (both trade and sale).
  uint256 public roundTime;

  // Always points to current round.
  uint256 public numRounds;

  // Token price multiplier in basis point.
  uint256 public tokenPriceMultiplier = 300;

  // Sale round reward for level 1 referrer in basis point.
  uint256 public refLvlOneRate = 500;

  // Sale round reward for level 2 referrer in basis point.
  uint256 public refLvlTwoRate = 300;

  // Trade round reward for referrers in basis point.
  uint256 public refTradeRate = 250;

  // The address of the ACDM token.
  address public token;

  // Shows the type of the current round (sale/trade)
  bool public isSaleRound;

  mapping(uint256 => Round) public rounds;      // roundID => Round
  mapping(uint256 => Order[]) public orders;    // roundID => orders[]
  mapping(address => address) public referrers; // referral => referrer

  /** @notice Creates Marketplace contract.
   * @dev Sets `msg.sender` as contract Admin
   * @param _token The address of the ACDM token.
   * @param _roundTime Round time (timestamp).
   */
  constructor(address _token, uint256 _roundTime) {
    roundTime = _roundTime;
    token = _token;
  }

  /** @notice Pausing some functions of contract.
   * @dev Available only to admin.
   * Prevents calls to functions with `whenNotPaused` modifier.
   */
  function pause() external onlyOwner {
    _pause();
  }

  /** @notice Unpausing functions of contract.
   * @dev Available only to admin
   * Allows calls to functions with `whenNotPaused` modifier.
   */
  function unpause() external onlyOwner {
    _unpause();
  }

  /** @notice Withdraws ether from contract.
   * @dev Available only to admin. Emits Withdraw event.
   * @param to The address to withdraw to.
   * @param amount The amount of ETH to withdraw.
   */
  function withdraw(address to, uint256 amount)
    external
    onlyOwner
    whenNotPaused
  {
    sendEther(to, amount);
    emit Withdraw(to, amount);
  }

  /** @notice Starting first Marketplace round.
   * @dev Mints `mintAmount` of tokens based on `startPrice` and `startVolume`.
   * @param startPrice Starting price per token.
   * @param startVolume Starting trade volume.
   */
  function initMarketplace(uint256 startPrice, uint256 startVolume)
    external
    onlyOwner
    whenNotPaused
  {
    isSaleRound = true;

    numRounds++;
    Round storage newRound = rounds[numRounds];
    newRound.createdAt = block.timestamp;
    newRound.endTime = block.timestamp + roundTime;
    newRound.price = startPrice;

    uint256 mintAmount = startVolume * (10 ** 18) / startPrice;
    newRound.tokensLeft = mintAmount;

    ACDMToken(token).mint(address(this), mintAmount);

    emit StartedSaleRound(numRounds, startPrice, 0, mintAmount);
  }

  /** @notice Allows the user to specify his referrer.
   * @dev Once it's called, the referrer can't be changed.
   * @param referrer The address of the referrer.
   */
  function registerUser(address referrer) external whenNotPaused {
    require(!hasReferrer(msg.sender), "Already has a referrer");
    require(referrer != msg.sender, "Can't be self-referrer");
    referrers[msg.sender] = referrer;
    emit UserRegistered(msg.sender, referrer);
  }

  /** @notice Placing new sale order.
   * @dev Available only on trade round. Requires token approve.
   * @param amount The amount of tokens to sell.
   * @param cost Total order cost (not per token).
   */
  function placeOrder(uint256 amount, uint256 cost) external whenNotPaused {
    require(!isSaleRound, "Can't place order on sale round");
    require(amount > 0, "Amount can't be zero");
    require(cost > 0, "Cost can't be zero");

    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

    uint256 tokenPrice = cost / (amount / 10 ** 18);

    orders[numRounds].push(Order({
      account: msg.sender,
      amount: amount,
      cost: cost,
      tokenPrice: tokenPrice,
      isOpen: true
    }));

    Round storage round = rounds[numRounds];
    round.tokensLeft += amount;

    emit PlacedOrder(numRounds, msg.sender, amount, cost);
  }

  /** @notice Cancelling user order.
   * @param id The id of the order to cancel.
   */
  function cancelOrder(uint256 id) external whenNotPaused {
    Order storage order = orders[numRounds][id];
    require(msg.sender == order.account, "Not your order");
    require(order.isOpen, "Already cancelled");

    rounds[numRounds].tokensLeft -= order.amount;
    _cancelOrder(order, id);
  }

  /** @notice Changes current round if conditions satisfied.
   * @dev Available only to contract owner.
   */
  function changeRound() external onlyOwner whenNotPaused {
    require(rounds[numRounds].endTime <= block.timestamp, "Need to wait 3 days");

    isSaleRound ? startTradeRound(rounds[numRounds].price, rounds[numRounds].tokensLeft)
      : startSaleRound(rounds[numRounds].price, rounds[numRounds].tradeVolume);
  }

  /** @notice Buying `amount` of tokens on sell round.
   * @dev If tokensLeft = 0 sets round.endTime to current timestamp i.e. marks round as ended.
   * 
   * Returns excess ether to `msg.sender`
   *
   * @param amount The amount of tokens to buy.
   */
  function buyTokens(uint256 amount)
    external
    payable
    nonReentrant
    whenNotPaused
  {
    require(isSaleRound, "Can't buy in trade round");
    require(amount > 0, "Amount can't be zero");
    Round storage round = rounds[numRounds];
    // Check that the round goes on
    require(round.endTime >= block.timestamp, "This round is ended");
    // Check that the user sent enough ether
    uint256 totalCost = calcCost(round.price, amount);
    require(msg.value >= totalCost, "Not enough ETH");
    
    // Transfer tokens
    IERC20(token).safeTransfer(msg.sender, amount);

    round.tokensLeft -= amount;
    round.tradeVolume += totalCost;

    // Send rewards to referrers
    payReferrers(msg.sender, totalCost);

    // Transfer excess ETH back to msg.sender
    if (msg.value - totalCost > 0) {
      sendEther(msg.sender, msg.value - totalCost);
    }

    emit TokenBuy(numRounds, msg.sender, address(this), amount, round.price, totalCost);
    
    // if (round.tokensLeft == 0) startTradeRound(round.price, round.tokensLeft);
    if (round.tokensLeft == 0) round.endTime = block.timestamp;
  }

  /** @notice Buying `amount` of tokens from order.
   * @dev If tokensLeft = 0 sets round.endTime to current timestamp i.e. marks round as ended.
   * 
   * Returns excess ether to `msg.sender`
   *
   * @param id The id of the order.
   * @param amount The amount of tokens to buy.
   */
  function buyOrder(uint256 id, uint256 amount)
    external
    payable
    nonReentrant
    whenNotPaused
  {
    require(amount > 0, "Amount can't be zero");
    require(id < orders[numRounds].length, "Incorrect order id");

    Order storage order = orders[numRounds][id];
    require(msg.sender != order.account, "Can't buy from yourself");
    require(order.isOpen, "Order is cancelled");
    require(amount <= order.amount, "Order doesn't have enough tokens");

    uint256 totalCost = calcCost(order.tokenPrice, amount);
    require(msg.value >= totalCost, "Not enough ETH");

    // Transfer tokens
    IERC20(token).safeTransfer(msg.sender, amount);

    Round storage round = rounds[numRounds];
    order.amount -= amount;
    round.tokensLeft -= amount;
    round.tradeVolume += totalCost;

    // Transfer 95% ETH to order owner (totalCost - 5% referrers rewards)
    sendEther(
      order.account,
      totalCost - (totalCost * (refTradeRate + refTradeRate) / BASIS_POINT)
    );

    // Send rewards to referrers
    payReferrers(order.account, totalCost);

    // Transfer excess ETH back to msg.sender
    if (msg.value - totalCost > 0) {
      sendEther(msg.sender, msg.value - totalCost);
    }

    emit TokenBuy(numRounds, msg.sender, order.account, amount, order.tokenPrice, totalCost);
  }

  /** @notice Gets current round data.
   * @return Object containing round data.
   */
  function getCurrentRoundData() external view returns (Round memory) {
    return rounds[numRounds];
  }

  /** @notice Gets round data by its id.
   * @return Object containing round data.
   */
  function getRoundData(uint256 id) external view returns (Round memory) {
    return rounds[id];
  }

  /** @notice Gets orders in current round.
   * @return Array of orders.
   */
  function getCurrentRoundOrders() external view returns (Order[] memory) {
    return orders[numRounds];
  }

  /** @notice Gets orders in specific round.
   * @param roundID The id of the round to get orders from.
   * @return Array of orders.
   */
  function getPastRoundOrders(uint256 roundID) external view returns (Order[] memory) {
    return orders[roundID];
  }

  /** @notice Gets order data.
   * @param roundID The id of the round to get order from.
   * @param id The id of the order.
   * @return Object containing order data.
   */
  function getOrderData(uint256 roundID, uint256 id) external view returns (Order memory) {
    return orders[roundID][id];
  }

  /** @notice Gets user referrer.
   * @param account The address of the user.
   * @return The address of the referrer.
   */
  function getUserReferrer(address account) public view returns (address) {
    return referrers[account];
  }

  /** @notice Gets user level 2 referrers.
   * @param account The address of the user.
   * @return List of referrers.
   */
  function getUserReferrers(address account) public view returns (address, address) {
    return (referrers[account], referrers[referrers[account]]);
  }

  /** @notice Checks if user have a referrer.
   * @param account The address of the user.
   * @return True if user have a referrer.
   */
  function hasReferrer(address account) public view returns (bool) {
    return referrers[account] != address(0);
  }

  /** @notice Calculates cost from `price` and `amount`.
   * @param price Price per token.
   * @param amount The amount of tokens.
   * @return The cost of the `amount` of tokens in uint.
   */
  function calcCost(uint256 price, uint256 amount) public pure returns (uint256) {
    return price * (amount / 10 ** 18);
  }

  /** @notice Sends `amount` of ether to `account`.
   * @dev We use `call()` instead of `send()` & `transfer()` because 
   * they take a hard dependency on gas costs by forwarding a fixed 
   * amount of gas: 2300 which may not be enough
   * https://consensys.net/diligence/blog/2019/09/stop-using-soliditys-transfer-now/
   *
   * @param account The address to send ether to.
   * @param amount The amount of ether.
   */
  function sendEther(address account, uint256 amount) private {
    (bool sent,) = account.call{value: amount}("");
    require(sent, "Failed to send Ether");
  }

  /** @notice Transfers reward in ETH to `account` referrers.
   * @dev This contract implements two-lvl referral system:
   *
   * In sale round Lvl1 referral gets `refLvlOneRate`% and Lvl2 gets `refLvlTwoRate`%
   * If there are no referrals or only one, the contract gets these percents
   *
   * In trade round every referral takes `refTradeRate`% reward
   * If there are no referrals or only one, the contract gets these percents
   *
   * @param account The account to get the referrals from.
   * @param sum The amount to calc reward from.
   */
  function payReferrers(address account, uint256 sum) private {
    if (hasReferrer(account)) {
      address ref1 = getUserReferrer(account);
      // Reward ref 1
      sendEther(ref1, sum * (isSaleRound ? refLvlOneRate : refTradeRate) / BASIS_POINT);
      // Reward ref 2 (if exists)
      if (hasReferrer(ref1) && getUserReferrer(ref1) != account) {
        sendEther(getUserReferrer(ref1), sum * (isSaleRound ? refLvlTwoRate : refTradeRate) / BASIS_POINT);
      }
    }
  }

  /** @notice Cancelling an order.
   * @dev Returns unsold tokens to order creator.
   * @param order Order object.
   */
  function _cancelOrder(Order storage order, uint256 id) private {
    order.isOpen = false;
    if (order.amount > 0) IERC20(token).safeTransfer(order.account, order.amount);
    emit CancelledOrder(numRounds, id, msg.sender);
  }

  /** @notice Starting new sale round.
   * @dev Starting sale round literally means "end trade round" so
   * here we cancelling trade round orders by calling `closeOpenOrders()`
   * and emitting `FinishedTradeRound` event.
   *
   * New token price calculated as: `oldPrice` + `tokenPriceMultiplier`% + 0.000004 ether
   *
   * @param oldPrice The price of the previous round.
   * @param tradeVolume Trading volume of the previous round.
   */
  function startSaleRound(uint256 oldPrice, uint256 tradeVolume) private {
    closeOpenOrders();
    uint256 newPrice = oldPrice + (oldPrice * tokenPriceMultiplier / BASIS_POINT) + 0.000004 ether;
    
    numRounds++;
    Round storage newRound = rounds[numRounds];
    newRound.createdAt = block.timestamp;
    newRound.endTime = block.timestamp + roundTime;
    newRound.price = newPrice;

    uint256 mintAmount = tradeVolume * (10 ** 18) / newPrice;
    ACDMToken(token).mint(address(this), mintAmount);

    newRound.tokensLeft = mintAmount;

    isSaleRound = true;
    emit FinishedTradeRound(numRounds - 1, tradeVolume);
    emit StartedSaleRound(numRounds, newPrice, oldPrice, mintAmount);
  }

  /** @notice Starting new trade round.
   * @dev Starting trade round literally means "end sale round" so
   * here we burning tokens unsold in sale round calling `burn()`
   * and emitting `FinishedSaleRound` event.
   *
   * @param oldPrice The price of the previous round.
   * @param tokensLeft The amount of unsold tokens left from sale round.
   */
  function startTradeRound(uint256 oldPrice, uint256 tokensLeft) private {
    if (tokensLeft > 0) ACDMToken(token).burn(address(this), tokensLeft);
  
    numRounds++;
    Round storage newRound = rounds[numRounds];
    newRound.createdAt = block.timestamp;
    newRound.endTime = block.timestamp + roundTime;
    newRound.price = oldPrice;

    isSaleRound = false;
    emit FinishedSaleRound(numRounds - 1, oldPrice, tokensLeft);
    emit StartedTradeRound(numRounds);
  }

  /** @notice Closing open orders. */
  function closeOpenOrders() private {
    Order[] storage orders = orders[numRounds];
    uint256 length = orders.length;
    for (uint256 i = 0; i < length; i++) {
      if (orders[i].isOpen) _cancelOrder(orders[i], i);
    }
  }
}