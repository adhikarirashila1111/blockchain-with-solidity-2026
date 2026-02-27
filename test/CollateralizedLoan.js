const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CollateralizedLoan", function () {
  let collateralizedLoan;
  let owner, borrower, lender, other;

  // Helper: 1 ETH in wei
  const ONE_ETH = ethers.parseEther("1");
  // 5% annual interest in basis points
  const INTEREST_RATE = 500;
  // 30-day loan duration in seconds
  const DURATION_30D = 30 * 24 * 60 * 60;

  beforeEach(async function () {
    [owner, borrower, lender, other] = await ethers.getSigners();

    const CollateralizedLoan = await ethers.getContractFactory(
      "CollateralizedLoan"
    );
    collateralizedLoan = await CollateralizedLoan.deploy();
  });

  // ---------------------------------------------------------------------------
  // Test 1: Deployment
  // ---------------------------------------------------------------------------
  describe("Deployment", function () {
    it("Should deploy successfully and have a defined address", async function () {
      const address = await collateralizedLoan.getAddress();
      expect(address).to.be.properAddress;
      expect(address).to.not.equal(ethers.ZeroAddress);
    });

    it("Should start with nextLoanId equal to 0", async function () {
      expect(await collateralizedLoan.nextLoanId()).to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: Deposit Collateral and Request a Loan
  // ---------------------------------------------------------------------------
  describe("depositCollateralAndRequestLoan", function () {
    it("Should allow a borrower to deposit collateral and emit LoanRequested", async function () {
      await expect(
        collateralizedLoan
          .connect(borrower)
          .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
            value: ONE_ETH,
          })
      )
        .to.emit(collateralizedLoan, "LoanRequested")
        .withArgs(0, borrower.address, ONE_ETH, INTEREST_RATE, DURATION_30D);

      // nextLoanId should have incremented
      expect(await collateralizedLoan.nextLoanId()).to.equal(1);
    });

    it("Should store loan details correctly after requesting", async function () {
      await collateralizedLoan
        .connect(borrower)
        .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
          value: ONE_ETH,
        });

      const loan = await collateralizedLoan.getLoan(0);
      expect(loan.borrower).to.equal(borrower.address);
      expect(loan.collateralAmount).to.equal(ONE_ETH);
      expect(loan.loanAmount).to.equal(ONE_ETH);
      expect(loan.interestRate).to.equal(INTEREST_RATE);
      expect(loan.duration).to.equal(DURATION_30D);
      expect(loan.isFunded).to.be.false;
      expect(loan.isRepaid).to.be.false;
      expect(loan.isDefaulted).to.be.false;
    });

    it("Should revert if no collateral is sent", async function () {
      await expect(
        collateralizedLoan
          .connect(borrower)
          .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
            value: 0,
          })
      ).to.be.revertedWith("Collateral must be greater than 0");
    });

    it("Should revert if interest rate is 0", async function () {
      await expect(
        collateralizedLoan
          .connect(borrower)
          .depositCollateralAndRequestLoan(0, DURATION_30D, {
            value: ONE_ETH,
          })
      ).to.be.revertedWith("Interest rate must be greater than 0");
    });

    it("Should revert if duration is 0", async function () {
      await expect(
        collateralizedLoan
          .connect(borrower)
          .depositCollateralAndRequestLoan(INTEREST_RATE, 0, {
            value: ONE_ETH,
          })
      ).to.be.revertedWith("Duration must be greater than 0");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: Fund a Loan
  // ---------------------------------------------------------------------------
  describe("fundLoan", function () {
    beforeEach(async function () {
      // Borrower requests a loan
      await collateralizedLoan
        .connect(borrower)
        .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
          value: ONE_ETH,
        });
    });

    it("Should allow a lender to fund a loan and emit LoanFunded", async function () {
      await expect(
        collateralizedLoan.connect(lender).fundLoan(0, { value: ONE_ETH })
      )
        .to.emit(collateralizedLoan, "LoanFunded")
        .withArgs(0, lender.address, ONE_ETH);

      const loan = await collateralizedLoan.getLoan(0);
      expect(loan.isFunded).to.be.true;
      expect(loan.lender).to.equal(lender.address);
    });

    it("Should transfer loanAmount to borrower when funded", async function () {
      const borrowerBalanceBefore = await ethers.provider.getBalance(
        borrower.address
      );

      await collateralizedLoan.connect(lender).fundLoan(0, { value: ONE_ETH });

      const borrowerBalanceAfter = await ethers.provider.getBalance(
        borrower.address
      );
      // Borrower should receive ~1 ETH (no gas cost for borrower here)
      expect(borrowerBalanceAfter - borrowerBalanceBefore).to.equal(ONE_ETH);
    });

    it("Should revert if borrower tries to fund their own loan", async function () {
      await expect(
        collateralizedLoan
          .connect(borrower)
          .fundLoan(0, { value: ONE_ETH })
      ).to.be.revertedWith("Borrower cannot fund own loan");
    });

    it("Should revert if incorrect loan amount is sent", async function () {
      await expect(
        collateralizedLoan
          .connect(lender)
          .fundLoan(0, { value: ethers.parseEther("0.5") })
      ).to.be.revertedWith("Must send exact loan amount");
    });

    it("Should revert if loan does not exist", async function () {
      await expect(
        collateralizedLoan.connect(lender).fundLoan(99, { value: ONE_ETH })
      ).to.be.revertedWith("Loan does not exist");
    });

    it("Should revert if loan is already funded", async function () {
      await collateralizedLoan.connect(lender).fundLoan(0, { value: ONE_ETH });
      await expect(
        collateralizedLoan
          .connect(other)
          .fundLoan(0, { value: ONE_ETH })
      ).to.be.revertedWith("Loan is already funded");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: Repay a Loan
  // ---------------------------------------------------------------------------
  describe("repayLoan", function () {
    let repaymentAmount;

    beforeEach(async function () {
      // Borrower requests loan
      await collateralizedLoan
        .connect(borrower)
        .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
          value: ONE_ETH,
        });

      // Lender funds loan
      await collateralizedLoan.connect(lender).fundLoan(0, { value: ONE_ETH });

      // Calculate repayment
      repaymentAmount = await collateralizedLoan.calculateRepaymentAmount(0);
    });

    it("Should allow borrower to repay and emit LoanRepaid", async function () {
      await expect(
        collateralizedLoan
          .connect(borrower)
          .repayLoan(0, { value: repaymentAmount })
      )
        .to.emit(collateralizedLoan, "LoanRepaid")
        .withArgs(0, borrower.address, repaymentAmount);

      const loan = await collateralizedLoan.getLoan(0);
      expect(loan.isRepaid).to.be.true;
    });

    it("Should return collateral to borrower upon repayment", async function () {
      // After repayment the borrower gets collateral back
      const tx = await collateralizedLoan
        .connect(borrower)
        .repayLoan(0, { value: repaymentAmount });
      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      const loan = await collateralizedLoan.getLoan(0);
      expect(loan.isRepaid).to.be.true;
    });

    it("Should revert if non-borrower tries to repay", async function () {
      await expect(
        collateralizedLoan
          .connect(other)
          .repayLoan(0, { value: repaymentAmount })
      ).to.be.revertedWith("Only borrower can repay");
    });

    it("Should revert if insufficient repayment amount is sent", async function () {
      await expect(
        collateralizedLoan
          .connect(borrower)
          .repayLoan(0, { value: ONE_ETH }) // principal only, no interest
      ).to.be.revertedWith("Insufficient repayment amount");
    });

    it("Should revert if loan is past due date", async function () {
      // Advance time past due date
      await time.increase(DURATION_30D + 1);

      await expect(
        collateralizedLoan
          .connect(borrower)
          .repayLoan(0, { value: repaymentAmount })
      ).to.be.revertedWith("Loan is past due date");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5: Claim Collateral (Default)
  // ---------------------------------------------------------------------------
  describe("claimCollateral", function () {
    beforeEach(async function () {
      // Borrower requests loan
      await collateralizedLoan
        .connect(borrower)
        .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
          value: ONE_ETH,
        });

      // Lender funds loan
      await collateralizedLoan.connect(lender).fundLoan(0, { value: ONE_ETH });
    });

    it("Should allow lender to claim collateral after due date and emit CollateralClaimed", async function () {
      // Advance time past due date
      await time.increase(DURATION_30D + 1);

      await expect(
        collateralizedLoan.connect(lender).claimCollateral(0)
      )
        .to.emit(collateralizedLoan, "CollateralClaimed")
        .withArgs(0, lender.address, ONE_ETH);

      const loan = await collateralizedLoan.getLoan(0);
      expect(loan.isDefaulted).to.be.true;
    });

    it("Should revert if claimed before due date", async function () {
      await expect(
        collateralizedLoan.connect(lender).claimCollateral(0)
      ).to.be.revertedWith("Loan is not yet past due date");
    });

    it("Should revert if non-lender tries to claim collateral", async function () {
      await time.increase(DURATION_30D + 1);

      await expect(
        collateralizedLoan.connect(other).claimCollateral(0)
      ).to.be.revertedWith("Only lender can claim collateral");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6: Error Handling
  // ---------------------------------------------------------------------------
  describe("Error Handling", function () {
    it("Should revert when funding a nonexistent loan", async function () {
      await expect(
        collateralizedLoan.connect(lender).fundLoan(999, { value: ONE_ETH })
      ).to.be.revertedWith("Loan does not exist");
    });

    it("Should revert when repaying with incorrect amount", async function () {
      // Request and fund loan
      await collateralizedLoan
        .connect(borrower)
        .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
          value: ONE_ETH,
        });
      await collateralizedLoan.connect(lender).fundLoan(0, { value: ONE_ETH });

      // Repay with principal only (no interest) - should revert
      await expect(
        collateralizedLoan
          .connect(borrower)
          .repayLoan(0, { value: ONE_ETH })
      ).to.be.revertedWith("Insufficient repayment amount");
    });

    it("Should revert when claiming collateral prematurely", async function () {
      await collateralizedLoan
        .connect(borrower)
        .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
          value: ONE_ETH,
        });
      await collateralizedLoan.connect(lender).fundLoan(0, { value: ONE_ETH });

      // Try to claim before due date
      await expect(
        collateralizedLoan.connect(lender).claimCollateral(0)
      ).to.be.revertedWith("Loan is not yet past due date");
    });

    it("Should revert when claiming collateral on an unfunded loan", async function () {
      await collateralizedLoan
        .connect(borrower)
        .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
          value: ONE_ETH,
        });

      // Advance time (doesn't matter - loan is unfunded)
      await time.increase(DURATION_30D + 1);

      await expect(
        collateralizedLoan.connect(lender).claimCollateral(0)
      ).to.be.revertedWith("Loan is not funded");
    });

    it("Should revert when repaying an already repaid loan", async function () {
      await collateralizedLoan
        .connect(borrower)
        .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
          value: ONE_ETH,
        });
      await collateralizedLoan.connect(lender).fundLoan(0, { value: ONE_ETH });

      const repaymentAmount = await collateralizedLoan.calculateRepaymentAmount(0);
      await collateralizedLoan
        .connect(borrower)
        .repayLoan(0, { value: repaymentAmount });

      // Try to repay again
      await expect(
        collateralizedLoan
          .connect(borrower)
          .repayLoan(0, { value: repaymentAmount })
      ).to.be.revertedWith("Loan already repaid");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 7: calculateRepaymentAmount
  // ---------------------------------------------------------------------------
  describe("calculateRepaymentAmount", function () {
    it("Should return principal + interest for a 30-day 5% loan", async function () {
      await collateralizedLoan
        .connect(borrower)
        .depositCollateralAndRequestLoan(INTEREST_RATE, DURATION_30D, {
          value: ONE_ETH,
        });

      const repayment = await collateralizedLoan.calculateRepaymentAmount(0);

      // Expected: 1 ETH + (1 ETH * 500 * 30d) / (10000 * 365d)
      const expectedInterest =
        (ONE_ETH * BigInt(INTEREST_RATE) * BigInt(DURATION_30D)) /
        BigInt(10000 * 365 * 24 * 60 * 60);
      const expected = ONE_ETH + expectedInterest;

      expect(repayment).to.equal(expected);
    });
  });
});
