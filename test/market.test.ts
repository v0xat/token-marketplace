import { expect } from "chai";
import { ethers } from "hardhat";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

// ACDMToken metadata
const tokenName = "ACDMToken";
const symbol = "ACDM";
const decimals = 18;
const initSupply = ethers.utils.parseUnits("100000.0", decimals);

// AccessControl roles in bytes32 string
// DEFAULT_ADMIN_ROLE, MINTER_ROLE, BURNER_ROLE
const adminRole = ethers.constants.HashZero;
const minterRole = ethers.utils.solidityKeccak256(["string"], ["MINTER_ROLE"]);
const burnerRole = ethers.utils.solidityKeccak256(["string"], ["BURNER_ROLE"]);

// Sample data
const roundTime = 259200; // 3 days in seconds
const startPrice = ethers.utils.parseEther("0.00001");
const startVolume = ethers.utils.parseEther("1.0");
const ratePct = 300; // 3%
const refLvlOneRate = 500; // 5%
const refLvlTwoRate = 300; // 3%
const refTradeRate = 250; // 2.5 %
const fixedRate = ethers.utils.parseEther("0.000004");
const oneEth = ethers.utils.parseEther("1.0");
const fiveTokens = ethers.utils.parseUnits("5.0", decimals);
const tenTokens = ethers.utils.parseUnits("10.0", decimals);
const twentyTokens = ethers.utils.parseUnits("20.0", decimals);
const firstOrder = 0;
const secondOrder = 1;
const thirdOrder = 2;
const saleRound1 = 1;
const tradeRound1 = 2;
const saleRound2 = 3;
const exp = ethers.BigNumber.from("10").pow(18);

const calcNewPrice = (oldPrice: BigNumber) =>
  oldPrice.add(oldPrice.mul(ratePct).div(10000)).add(fixedRate);

const calcMintAmount = (price: BigNumber, volume: BigNumber) =>
  volume.mul(exp).div(calcNewPrice(price));

describe("ACDM Marketplace", function () {
  let mp: Contract,
    acdmToken: Contract,
    Marketplace: ContractFactory,
    ACDMToken: ContractFactory,
    owner: SignerWithAddress,
    alice: SignerWithAddress,
    bob: SignerWithAddress;

  before(async () => {
    [owner, alice, bob] = await ethers.getSigners();
    ACDMToken = await ethers.getContractFactory("ACDMToken");
    Marketplace = await ethers.getContractFactory("Marketplace");
  });

  beforeEach(async () => {
    // Deploy token
    acdmToken = await ACDMToken.deploy(tokenName, symbol);
    await acdmToken.deployed();

    // Deploy Marketplace contract
    mp = await Marketplace.deploy(acdmToken.address, roundTime);
    await mp.deployed();

    // Grant Minter & Burner role to Marketplace
    await acdmToken.grantRole(minterRole, mp.address);
    await acdmToken.grantRole(burnerRole, mp.address);

    // Starting sale round
    await mp.initMarketplace(startPrice, startVolume);
  });

  describe("Deployment", function () {
    it("Should set right token contract address", async () => {
      expect(await mp.token()).to.be.equal(acdmToken.address);
    });

    it("Should set right Marketplace owner", async () => {
      expect(await mp.owner()).to.equal(owner.address);
    });

    it("Non owner should not be able to init Marketplace", async () => {
      await expect(
        mp.connect(alice).initMarketplace(startPrice, startVolume)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should set right Token owner", async () => {
      expect(await acdmToken.hasRole(adminRole, owner.address)).to.equal(true);
    });

    it("Should set right round time", async () => {
      expect(await mp.roundTime()).to.be.equal(roundTime);
    });

    it("Should set minter & burner role to marketplace", async () => {
      expect(await acdmToken.hasRole(minterRole, mp.address)).to.equal(true);
      expect(await acdmToken.hasRole(burnerRole, mp.address)).to.equal(true);
    });

    it("Should start sale round with correct params", async () => {
      expect(await acdmToken.balanceOf(mp.address)).to.be.equal(initSupply);
      const round = await mp.getCurrentRoundData();
      expect(await mp.isSaleRound()).to.be.equal(true);
      expect(round.price).to.be.equal(startPrice);
      expect(round.tokensLeft).to.be.equal(initSupply);
    });
  });

  describe("Withdraw", function () {
    beforeEach(async () => {
      // Buy 20 tokens for Owner & Alice
      const requiredEth = startPrice.mul(20);
      await mp.buyTokens(twentyTokens, { value: requiredEth });
      await mp.connect(alice).buyTokens(twentyTokens, { value: requiredEth });
      await mp.connect(bob).buyTokens(twentyTokens, { value: requiredEth });
    });

    it("Admin should be able to withdraw ETH", async () => {
      const amount = startPrice.mul(60); // the amount of ETH that must be on the contract
      await expect(await mp.withdraw(owner.address, amount)).to.changeEtherBalances(
        [owner, mp],
        [amount, -amount]
      );
    });

    it("Withdraw emits event", async () => {
      const amount = startPrice.mul(60); // the amount of ETH that must be on the contract
      expect(await mp.withdraw(owner.address, amount))
        .to.emit(mp, "Withdraw")
        .withArgs(owner.address, amount);
    });

    it("Only admin should be able to withdraw", async () => {
      await expect(mp.connect(alice).withdraw(alice.address, oneEth)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });

  describe("Pausable", function () {
    it("Should be able to pause & unpause contract", async () => {
      await mp.pause();
      await expect(mp.withdraw(alice.address, oneEth)).to.be.revertedWith(
        "Pausable: paused"
      );
      await mp.unpause();
      await mp.initMarketplace(startPrice, startVolume);
    });

    it("Only admin should be able to pause contract", async () => {
      await expect(mp.connect(alice).pause()).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });

  describe("Getters", function () {
    it("Can get current round data", async () => {
      const round = await mp.getCurrentRoundData();
      expect(round.tradeVolume).to.be.equal(0);
      expect(round.tokensLeft).to.be.equal(initSupply);
      expect(round.price).to.be.equal(startPrice);
    });

    it("Can get round data by ID", async () => {
      const round = await mp.getRoundData(saleRound1);
      expect(round.tradeVolume).to.be.equal(0);
      expect(round.tokensLeft).to.be.equal(initSupply);
      expect(round.price).to.be.equal(startPrice);
    });

    it("Can check if user have a referrer", async () => {
      await mp.registerUser(alice.address);
      await mp.connect(bob).registerUser(owner.address);
      expect(await mp.hasReferrer(owner.address)).to.be.equal(true);
      expect(await mp.hasReferrer(alice.address)).to.be.equal(false);
      expect(await mp.hasReferrer(bob.address)).to.be.equal(true);
    });

    it("Can get user referrers", async () => {
      await mp.registerUser(alice.address);
      await mp.connect(bob).registerUser(owner.address);
      const ownerRefs = await mp.getUserReferrers(owner.address);
      const aliceRefs = await mp.getUserReferrers(alice.address);
      const bobRefs = await mp.getUserReferrers(bob.address);
      expect(ownerRefs[0]).to.be.equal(alice.address);
      expect(ownerRefs[1]).to.be.equal(ethers.constants.AddressZero);
      expect(aliceRefs[0]).to.be.equal(ethers.constants.AddressZero);
      expect(aliceRefs[1]).to.be.equal(ethers.constants.AddressZero);
      expect(bobRefs[0]).to.be.equal(owner.address);
      expect(bobRefs[1]).to.be.equal(alice.address);
    });
  });

  describe("Sale round", function () {
    it("Should be able to buy tokens on sale round", async () => {
      await mp.buyTokens(tenTokens, { value: oneEth });
      expect(await acdmToken.balanceOf(owner.address)).to.equal(tenTokens);
      expect(await acdmToken.balanceOf(mp.address)).to.equal(initSupply.sub(tenTokens));
    });

    it("Referrers must get their rewards", async () => {
      await mp.registerUser(alice.address);
      await mp.connect(bob).registerUser(owner.address);

      const requiredEth = startPrice.mul(10);
      const ref1Reward = requiredEth.mul(refLvlOneRate).div(10000);
      const ref2Reward = requiredEth.mul(refLvlTwoRate).div(10000);

      // Owner should pay 5% to Alice, Market should get 95%
      await expect(
        await mp.buyTokens(tenTokens, { value: requiredEth })
      ).to.changeEtherBalances(
        [mp, owner, alice],
        [requiredEth.sub(ref1Reward), -requiredEth, ref1Reward]
      );
      // Alice should not pay to anyone, Market should get 100%
      await expect(
        await mp.connect(alice).buyTokens(tenTokens, { value: requiredEth })
      ).to.changeEtherBalances([alice, mp], [-requiredEth, requiredEth]);

      // Bob should pay 5% to Owner and 3% to Alice, Market should get 92%
      await expect(
        await mp.connect(bob).buyTokens(tenTokens, { value: requiredEth })
      ).to.changeEtherBalances(
        [mp, owner, alice],
        [requiredEth.sub(ref1Reward).sub(ref2Reward), ref1Reward, ref2Reward]
      );
    });

    it("Buying shoud emit event", async () => {
      const requiredEth = startPrice.mul(10);
      expect(await mp.buyTokens(tenTokens, { value: requiredEth }))
        .to.emit(mp, "TokenBuy")
        .withArgs(
          saleRound1,
          owner.address,
          mp.address,
          tenTokens,
          startPrice,
          requiredEth
        );
    });

    it("Must return the excess ether", async () => {
      // Calc how much user should pay for 10 tokens
      const requiredEth = startPrice.mul(10);
      // Send a lot more ETH than required and check
      // that the balances have changed only by the required amount
      await expect(
        await mp.buyTokens(tenTokens, { value: oneEth })
      ).to.changeEtherBalances([owner, mp], [-requiredEth, requiredEth]);
    });

    it("Should not be able to buy with insufficient ether", async () => {
      // 5 tokens price in ETH
      const requiredEth = startPrice.mul(5);
      // Trying to buy 10
      await expect(mp.buyTokens(tenTokens, { value: requiredEth })).to.be.revertedWith(
        "Not enough ETH"
      );
    });

    it("Should not be able to buy zero tokens", async () => {
      await expect(
        mp.buyTokens(ethers.constants.Zero, { value: oneEth })
      ).to.be.revertedWith("Amount can't be zero");
    });

    it("Should not be able to buy above available amount", async () => {
      await expect(
        mp.buyTokens(initSupply.add(tenTokens), { value: oneEth.mul(2) })
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });

    it("Should not be able to place order on sale round", async () => {
      await expect(mp.placeOrder(tenTokens, ethers.constants.One)).to.be.revertedWith(
        "Can't place order on sale round"
      );
    });

    describe("Finish sale", function () {
      it("Should not be able to finish round before 3 days", async () => {
        await expect(mp.changeRound()).to.be.revertedWith("Need to wait 3 days");
      });

      it("Should be able to manually finish round after 3 days & emit events", async () => {
        await ethers.provider.send("evm_increaseTime", [259200]);
        expect(await mp.changeRound())
          .to.emit(mp, "FinishedSaleRound")
          .withArgs(saleRound1, startPrice, initSupply)
          .and.to.emit(mp, "StartedTradeRound")
          .withArgs(tradeRound1);
      });

      it("At the end of the round unsold tokens must be burned", async () => {
        await ethers.provider.send("evm_increaseTime", [259200]);
        expect(await mp.changeRound())
          .to.emit(acdmToken, "Transfer")
          .withArgs(mp.address, ethers.constants.AddressZero, initSupply);
        expect(await acdmToken.balanceOf(mp.address)).to.be.equal(0);
      });

      it("Price should not change after sale round", async () => {
        await ethers.provider.send("evm_increaseTime", [259200]);
        await mp.changeRound();
        const round = await mp.getCurrentRoundData();
        expect(round.price).to.be.equal(startPrice);
      });

      it("Round should be marked finished if all tokens sold", async () => {
        // Buying all tokens
        mp.buyTokens(initSupply, { value: oneEth.mul(2) });
        // Check that we cant buy anymore
        await expect(mp.buyTokens(tenTokens, { value: oneEth })).to.be.revertedWith(
          "This round is ended"
        );
        // Check that we can change round early
        expect(await mp.changeRound())
          .to.emit(mp, "FinishedSaleRound")
          .withArgs(saleRound1, startPrice, 0)
          .and.to.emit(mp, "StartedTradeRound")
          .withArgs(tradeRound1);
      });
    });
  });

  describe("Trade round", function () {
    beforeEach(async () => {
      // Buy 20 tokens for Owner & Alice
      const requiredEth = startPrice.mul(20);
      await mp.buyTokens(twentyTokens, { value: requiredEth });
      await mp.connect(alice).buyTokens(twentyTokens, { value: requiredEth });
      await mp.connect(bob).buyTokens(twentyTokens, { value: requiredEth });
      // Approve tokens to be able to place order
      await acdmToken.approve(mp.address, twentyTokens);
      await acdmToken.connect(alice).approve(mp.address, twentyTokens);
      await acdmToken.connect(bob).approve(mp.address, twentyTokens);
      // Starting trade round
      await ethers.provider.send("evm_increaseTime", [259200]);
      await mp.changeRound();
    });

    it("Should start trade round with correct params", async () => {
      const round = await mp.getCurrentRoundData();
      expect(await mp.isSaleRound()).to.be.equal(false);
      expect(round.price).to.be.equal(startPrice);
      expect(round.tradeVolume).to.be.equal(0);
      expect(round.tokensLeft).to.be.equal(0);
    });

    it("Should be able to place order", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      expect(await acdmToken.balanceOf(owner.address)).to.equal(
        twentyTokens.sub(tenTokens)
      );
      await mp.connect(alice).placeOrder(tenTokens, oneEth);
      expect(await acdmToken.balanceOf(alice.address)).to.equal(
        twentyTokens.sub(tenTokens)
      );
      const orders = await mp.getCurrentRoundOrders();
      expect(orders.length).to.be.equal(2);
    });

    it("Placing an order should trigger event", async () => {
      expect(await mp.placeOrder(tenTokens, oneEth))
        .to.emit(mp, "PlacedOrder")
        .withArgs(await mp.numRounds(), owner.address, tenTokens, oneEth);
    });

    it("Should not be able to place order if there are not enough tokens", async () => {
      await expect(
        mp.placeOrder(twentyTokens.add(twentyTokens), oneEth)
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });

    it("Should not be able to place order with zero tokens", async () => {
      await expect(mp.placeOrder(ethers.constants.Zero, oneEth)).to.be.revertedWith(
        "Amount can't be zero"
      );
    });

    it("Should not be able to place order with zero cost", async () => {
      await expect(mp.placeOrder(twentyTokens, ethers.constants.Zero)).to.be.revertedWith(
        "Cost can't be zero"
      );
    });

    it("Cancelling an order triggers an event", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      expect(await mp.cancelOrder(firstOrder))
        .to.emit(mp, "CancelledOrder")
        .withArgs(await mp.numRounds(), firstOrder, owner.address);
    });

    it("Cancelling an order returns tokens to user", async () => {
      const initBalance = await acdmToken.balanceOf(owner.address);
      await mp.placeOrder(tenTokens, oneEth);
      await mp.cancelOrder(firstOrder);
      const newBalance = await acdmToken.balanceOf(owner.address);
      expect(newBalance).to.be.equal(initBalance);
    });

    it("Should not be able to cancel someone else's order", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      await expect(mp.connect(alice).cancelOrder(firstOrder)).to.be.revertedWith(
        "Not your order"
      );
    });

    it("Should not be able to cancel cancelled order", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      await mp.cancelOrder(firstOrder);
      await expect(mp.cancelOrder(firstOrder)).to.be.revertedWith("Already cancelled");
    });

    it("Should not be able to buy from marketplace", async () => {
      await expect(mp.buyTokens(tenTokens, { value: oneEth })).to.be.revertedWith(
        "Can't buy in trade round"
      );
    });

    it("Should not be able to buy from yourself", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      await expect(
        mp.buyOrder(firstOrder, tenTokens, { value: oneEth })
      ).to.be.revertedWith("Can't buy from yourself");
    });

    it("Should not be able to buy zero tokens", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      await expect(
        mp.connect(alice).buyOrder(firstOrder, ethers.constants.Zero, { value: oneEth })
      ).to.be.revertedWith("Amount can't be zero");
    });

    it("Should not be able to buy non-existent order", async () => {
      await expect(mp.buyOrder(firstOrder, tenTokens)).to.be.revertedWith(
        "Incorrect order id"
      );
    });

    it("Should not be able to buy cancelled order", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      await mp.cancelOrder(firstOrder);
      await expect(mp.connect(alice).buyOrder(firstOrder, tenTokens)).to.be.revertedWith(
        "Order is cancelled"
      );
    });

    it("Should not be able to buy with insufficient ether", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      await expect(mp.connect(alice).buyOrder(firstOrder, tenTokens)).to.be.revertedWith(
        "Not enough ETH"
      );
    });

    it("Should not be able to buy more than available", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      await expect(
        mp.connect(alice).buyOrder(firstOrder, twentyTokens)
      ).to.be.revertedWith("Order doesn't have enough tokens");
    });

    it("Buying order triggers an event", async () => {
      await mp.placeOrder(tenTokens, oneEth);
      const price = oneEth.div(10);
      expect(await mp.connect(alice).buyOrder(firstOrder, tenTokens, { value: oneEth }))
        .to.emit(mp, "TokenBuy")
        .withArgs(tradeRound1, alice.address, owner.address, tenTokens, price, oneEth);
    });

    it("Should be able to buy out the order", async () => {
      await mp.placeOrder(twentyTokens, oneEth);
      const aliceInitBalance = await acdmToken.balanceOf(alice.address);
      await mp.connect(alice).buyOrder(firstOrder, twentyTokens, { value: oneEth });
      const newAliceBalance = await acdmToken.balanceOf(alice.address);
      // Check token balance changed
      expect(newAliceBalance).to.be.equal(aliceInitBalance.add(twentyTokens));
      // Check order data changed
      const orderData = await mp.getOrderData(tradeRound1, firstOrder);
      expect(orderData.amount).to.be.equal(ethers.constants.Zero);
      // expect(orderData.isOpen).to.be.equal(false);
    });

    it("Should be able to buy part of the order", async () => {
      await mp.placeOrder(twentyTokens, oneEth);
      const aliceInitBalance = await acdmToken.balanceOf(alice.address);
      await mp.connect(alice).buyOrder(firstOrder, tenTokens, { value: oneEth });
      const newAliceBalance = await acdmToken.balanceOf(alice.address);
      // Check token balance changed
      expect(newAliceBalance).to.be.equal(aliceInitBalance.add(tenTokens));
      // Check order data changed
      const orderData = await mp.getOrderData(tradeRound1, firstOrder);
      expect(orderData.amount).to.be.equal(tenTokens);
      expect(orderData.isOpen).to.be.equal(true);
    });

    it("Cancelling partly bought order returns tokens left", async () => {
      const initBalance = await acdmToken.balanceOf(owner.address);
      await mp.placeOrder(twentyTokens, oneEth);
      await mp.connect(alice).buyOrder(firstOrder, tenTokens, { value: oneEth });
      await mp.cancelOrder(firstOrder);
      const newBalance = await acdmToken.balanceOf(owner.address);
      expect(newBalance).to.be.equal(initBalance.sub(tenTokens));
    });

    it("Referrers must get their rewards", async () => {
      // Set referrers
      await mp.registerUser(alice.address);
      await mp.connect(bob).registerUser(owner.address);
      // Place 20 tokens in order
      await mp.placeOrder(twentyTokens, oneEth);
      await mp.connect(alice).placeOrder(twentyTokens, oneEth);
      await mp.connect(bob).placeOrder(twentyTokens, oneEth);
      // Calc 5 tokens price (1/4 of total cost) & referrers rewards
      const requiredEth = oneEth.div(4);
      const refTradeReward = requiredEth.mul(refTradeRate).div(10000);

      // Owner should get 95%, Alice & Market should get 2.5%
      await expect(
        await mp.connect(bob).buyOrder(firstOrder, fiveTokens, { value: requiredEth })
      ).to.changeEtherBalances(
        [owner, alice, mp],
        [
          requiredEth.sub(refTradeReward).sub(refTradeReward),
          refTradeReward,
          refTradeReward,
        ]
      );
      // Alice should get 95%, Market should get 5%
      await expect(
        await mp.buyOrder(secondOrder, fiveTokens, { value: requiredEth })
      ).to.changeEtherBalances(
        [alice, mp],
        [
          requiredEth.sub(refTradeReward).sub(refTradeReward),
          refTradeReward.add(refTradeReward),
        ]
      );
      // Bob should get 95%, Alice and Owner should get 2.5%
      // CHECK OWNER BALANCE
      await expect(
        await mp.buyOrder(thirdOrder, fiveTokens, { value: requiredEth })
      ).to.changeEtherBalances(
        [bob, alice],
        [
          requiredEth.sub(refTradeReward).sub(refTradeReward),
          refTradeReward,
          // requiredEth.sub(refTradeReward),
        ]
      );
    });

    describe("Finish trade", function () {
      it("Should not be able to finish round before 3 days", async () => {
        await expect(mp.changeRound()).to.be.revertedWith("Need to wait 3 days");
      });

      it("Should be able to finish round after 3 days & emit events", async () => {
        await ethers.provider.send("evm_increaseTime", [259200]);
        expect(await mp.changeRound())
          .to.emit(mp, "FinishedTradeRound")
          .withArgs(tradeRound1, 0)
          .to.emit(mp, "StartedSaleRound")
          .withArgs(saleRound2, calcNewPrice(startPrice), startPrice, 0);
      });

      it("Should change token price correctly", async () => {
        // Check first change
        await ethers.provider.send("evm_increaseTime", [259200]);
        await mp.changeRound();
        let round = await mp.getCurrentRoundData();
        const price = calcNewPrice(startPrice);
        expect(round.price).to.be.equal(price);

        // Skipping sale round (price not changed)
        await ethers.provider.send("evm_increaseTime", [259200]);
        await mp.changeRound();

        // Check second change
        await ethers.provider.send("evm_increaseTime", [259200]);
        await mp.changeRound();
        round = await mp.getCurrentRoundData();
        expect(round.price).to.be.equal(calcNewPrice(price));
      });

      it("Should mint new tokens correctly", async () => {
        // Should mint 0 because of 0 trade volume
        await ethers.provider.send("evm_increaseTime", [259200]);
        expect(await mp.changeRound())
          .to.emit(acdmToken, "Transfer")
          .withArgs(ethers.constants.AddressZero, mp.address, 0);
        expect(await acdmToken.balanceOf(mp.address)).to.be.equal(0);

        // Skipping sale round
        await ethers.provider.send("evm_increaseTime", [259200]);
        await mp.changeRound();

        // Increasing trade volume
        await mp.placeOrder(twentyTokens, oneEth);
        await mp.connect(alice).placeOrder(twentyTokens, oneEth);
        await mp.buyOrder(secondOrder, twentyTokens, { value: oneEth });
        await mp.connect(alice).buyOrder(firstOrder, fiveTokens, { value: oneEth });

        // Check mint again
        const round = await mp.getCurrentRoundData();
        const mintAmount = calcMintAmount(round.price, round.tradeVolume);
        await ethers.provider.send("evm_increaseTime", [259200]);
        expect(await mp.changeRound())
          .to.emit(acdmToken, "Transfer")
          .withArgs(ethers.constants.AddressZero, mp.address, mintAmount);
        expect(await acdmToken.balanceOf(mp.address)).to.be.equal(mintAmount);
      });

      it("Should close all order and return tokens at the end of round", async () => {
        // Place orders
        await mp.placeOrder(twentyTokens, oneEth);
        await mp.connect(alice).placeOrder(twentyTokens, oneEth);
        await mp.connect(bob).placeOrder(twentyTokens, oneEth);
        // Close ronud
        await ethers.provider.send("evm_increaseTime", [259200]);
        await mp.changeRound();
        // Check orders status
        const orders = await mp.getPastRoundOrders(tradeRound1);
        expect(orders[0].isOpen).to.be.equal(false);
        expect(orders[1].isOpen).to.be.equal(false);
        expect(orders[2].isOpen).to.be.equal(false);
        // Check tokens returned
        expect(await acdmToken.balanceOf(owner.address)).to.equal(twentyTokens);
        expect(await acdmToken.balanceOf(alice.address)).to.equal(twentyTokens);
        expect(await acdmToken.balanceOf(bob.address)).to.be.equal(twentyTokens);
      });
    });
  });

  describe("Referrals", function () {
    it("Should be able to register user", async () => {
      await mp.registerUser(alice.address);
      expect(await mp.referrers(owner.address)).to.be.equal(alice.address);
      await mp.connect(bob).registerUser(alice.address);
      expect(await mp.referrers(bob.address)).to.be.equal(alice.address);
    });

    it("User register emits event", async () => {
      expect(await mp.registerUser(alice.address))
        .to.emit(mp, "UserRegistered")
        .withArgs(owner.address, alice.address);
    });

    it("Should not be able to register themselves as referrers", async () => {
      await expect(mp.registerUser(owner.address)).to.be.revertedWith(
        "Can't be self-referrer"
      );
    });

    it("Should not be able to register referrer twice", async () => {
      await mp.registerUser(alice.address);
      await expect(mp.registerUser(alice.address)).to.be.revertedWith(
        "Already has a referrer"
      );
    });

    it("Two-step referral program", async () => {
      await mp.registerUser(alice.address);
      await mp.connect(bob).registerUser(owner.address);
      // Alice should have 0 referrers
      const aliceRefs = await mp.getUserReferrers(alice.address);
      expect(aliceRefs[0]).to.be.equal(ethers.constants.AddressZero);
      expect(aliceRefs[1]).to.be.equal(ethers.constants.AddressZero);
      // Owner should have one ref (Alice)
      const ownerRefs = await mp.getUserReferrers(owner.address);
      expect(ownerRefs[0]).to.be.equal(alice.address);
      expect(ownerRefs[1]).to.be.equal(ethers.constants.AddressZero);
      // Bob should have two referrers (Owner & Alice)
      const bobRefs = await mp.getUserReferrers(bob.address);
      expect(bobRefs[0]).to.be.equal(owner.address);
      expect(bobRefs[1]).to.be.equal(alice.address);
    });
  });
});
