// scripts/deploy.js
const { ethers } = require("hardhat");

async function main() {
  console.log("Deploying CollateralizedLoan...");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer address : ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance : ${ethers.formatEther(balance)} ETH`);

  // Deploy contract
  const CollateralizedLoan = await ethers.getContractFactory(
    "CollateralizedLoan"
  );
  const contract = await CollateralizedLoan.deploy();
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log(`\nCollateralizedLoan deployed to: ${contractAddress}`);
  console.log(
    `\nVerify on Etherscan:\nhttps://sepolia.etherscan.io/address/${contractAddress}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
