// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title CollateralizedLoan
 * @notice A smart contract for managing ETH-collateralized loans.
 *         Borrowers deposit ETH as collateral, lenders fund loans,
 *         borrowers repay with interest, and lenders can claim collateral
 *         if a borrower defaults.
 */
contract CollateralizedLoan {
    // -------------------------------------------------------------------------
    // Data Structures
    // -------------------------------------------------------------------------

    /// @notice Represents the full state of a single loan
    struct Loan {
        address payable borrower;    // Who took the loan
        address payable lender;      // Who funded the loan (address(0) if unfunded)
        uint256 collateralAmount;    // ETH deposited as collateral (wei)
        uint256 loanAmount;          // ETH lent to the borrower (== collateralAmount)
        uint256 interestRate;        // Annual interest rate in basis points (e.g., 500 = 5%)
        uint256 duration;            // Loan duration in seconds
        uint256 startTime;           // Block timestamp when the loan was funded
        uint256 dueDate;             // startTime + duration
        bool isFunded;               // True once a lender has funded the loan
        bool isRepaid;               // True once the borrower has repaid
        bool isDefaulted;            // True once the lender has claimed collateral
    }

    // -------------------------------------------------------------------------
    // State Variables
    // -------------------------------------------------------------------------

    /// @notice Incrementing counter used as loan ID
    uint256 public nextLoanId;

    /// @notice Maps loan ID → Loan struct
    mapping(uint256 => Loan) public loans;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when a borrower deposits collateral and creates a loan request
    event LoanRequested(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 collateralAmount,
        uint256 interestRate,
        uint256 duration
    );

    /// @notice Emitted when a lender funds an open loan
    event LoanFunded(
        uint256 indexed loanId,
        address indexed lender,
        uint256 loanAmount
    );

    /// @notice Emitted when a borrower repays a loan
    event LoanRepaid(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 repaymentAmount
    );

    /// @notice Emitted when a lender claims collateral after a default
    event CollateralClaimed(
        uint256 indexed loanId,
        address indexed lender,
        uint256 collateralAmount
    );

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    /// @notice Ensures the referenced loan exists
    modifier loanExists(uint256 loanId) {
        require(loanId < nextLoanId, "Loan does not exist");
        _;
    }

    /// @notice Ensures the loan has been funded by a lender
    modifier loanFunded(uint256 loanId) {
        require(loans[loanId].isFunded, "Loan is not funded");
        _;
    }

    /// @notice Ensures the loan has not yet been repaid or defaulted
    modifier loanActive(uint256 loanId) {
        require(!loans[loanId].isRepaid, "Loan already repaid");
        require(!loans[loanId].isDefaulted, "Loan already defaulted");
        _;
    }

    // -------------------------------------------------------------------------
    // External Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Deposit ETH as collateral and create a loan request.
     * @dev The msg.value is locked as collateral; the loan amount equals the collateral.
     * @param interestRate  Annual interest rate in basis points (1 bp = 0.01%)
     * @param duration      Loan duration in seconds
     */
    function depositCollateralAndRequestLoan(
        uint256 interestRate,
        uint256 duration
    ) external payable {
        require(msg.value > 0, "Collateral must be greater than 0");
        require(interestRate > 0, "Interest rate must be greater than 0");
        require(duration > 0, "Duration must be greater than 0");

        uint256 loanId = nextLoanId++;

        loans[loanId] = Loan({
            borrower: payable(msg.sender),
            lender: payable(address(0)),
            collateralAmount: msg.value,
            loanAmount: msg.value,        // loan amount = collateral amount
            interestRate: interestRate,
            duration: duration,
            startTime: 0,
            dueDate: 0,
            isFunded: false,
            isRepaid: false,
            isDefaulted: false
        });

        emit LoanRequested(loanId, msg.sender, msg.value, interestRate, duration);
    }

    /**
     * @notice Fund an open loan by sending the exact loan amount in ETH.
     * @dev Sends the loan amount to the borrower and records the lender.
     * @param loanId  ID of the loan to fund
     */
    function fundLoan(uint256 loanId)
        external
        payable
        loanExists(loanId)
        loanActive(loanId)
    {
        Loan storage loan = loans[loanId];

        require(!loan.isFunded, "Loan is already funded");
        require(msg.sender != loan.borrower, "Borrower cannot fund own loan");
        require(msg.value == loan.loanAmount, "Must send exact loan amount");

        loan.lender = payable(msg.sender);
        loan.isFunded = true;
        loan.startTime = block.timestamp;
        loan.dueDate = block.timestamp + loan.duration;

        // Transfer loan amount to borrower
        loan.borrower.transfer(msg.value);

        emit LoanFunded(loanId, msg.sender, msg.value);
    }

    /**
     * @notice Repay the loan principal plus interest before the due date.
     * @dev Collateral is returned to the borrower upon successful repayment.
     * @param loanId  ID of the loan to repay
     */
    function repayLoan(uint256 loanId)
        external
        payable
        loanExists(loanId)
        loanFunded(loanId)
        loanActive(loanId)
    {
        Loan storage loan = loans[loanId];

        require(msg.sender == loan.borrower, "Only borrower can repay");
        require(block.timestamp <= loan.dueDate, "Loan is past due date");

        uint256 repaymentAmount = calculateRepaymentAmount(loanId);
        require(msg.value >= repaymentAmount, "Insufficient repayment amount");

        loan.isRepaid = true;

        // Transfer repayment (principal + interest) to lender
        loan.lender.transfer(repaymentAmount);

        // Return collateral to borrower
        loan.borrower.transfer(loan.collateralAmount);

        // Refund any overpayment
        if (msg.value > repaymentAmount) {
            payable(msg.sender).transfer(msg.value - repaymentAmount);
        }

        emit LoanRepaid(loanId, msg.sender, repaymentAmount);
    }

    /**
     * @notice Allow the lender to claim collateral after the loan due date passes
     *         without repayment.
     * @param loanId  ID of the defaulted loan
     */
    function claimCollateral(uint256 loanId)
        external
        loanExists(loanId)
        loanFunded(loanId)
        loanActive(loanId)
    {
        Loan storage loan = loans[loanId];

        require(msg.sender == loan.lender, "Only lender can claim collateral");
        require(block.timestamp > loan.dueDate, "Loan is not yet past due date");

        loan.isDefaulted = true;

        // Transfer collateral to lender
        loan.lender.transfer(loan.collateralAmount);

        emit CollateralClaimed(loanId, msg.sender, loan.collateralAmount);
    }

    // -------------------------------------------------------------------------
    // View / Pure Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Calculate the total repayment amount (principal + interest).
     * @dev Simple interest: amount = principal * (1 + rate * time / year)
     *      where rate is in basis points (1 bp = 0.01% = 1/10000).
     * @param loanId  ID of the loan
     * @return Total ETH (wei) the borrower must repay
     */
    function calculateRepaymentAmount(uint256 loanId)
        public
        view
        loanExists(loanId)
        returns (uint256)
    {
        Loan storage loan = loans[loanId];

        // Simple interest: interest = principal * rate * elapsed / (10000 * 365 days)
        uint256 elapsed = loan.duration; // Use full duration for consistent calculation
        uint256 interest = (loan.loanAmount * loan.interestRate * elapsed) /
            (10000 * 365 days);

        return loan.loanAmount + interest;
    }

    /**
     * @notice Get the full details of a loan.
     * @param loanId  ID of the loan
     * @return The Loan struct
     */
    function getLoan(uint256 loanId)
        external
        view
        loanExists(loanId)
        returns (Loan memory)
    {
        return loans[loanId];
    }
}
