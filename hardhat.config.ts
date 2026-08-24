import { defineConfig } from "hardhat/config";
import HardhatIgnitionViem from "@nomicfoundation/hardhat-ignition-viem";
import "dotenv/config";

// All secrets pulled from .env — never hardcoded.
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY && process.argv.some(a => a.includes('deploy') || a === 'run')) {
    // Only warn on operations that need it; `hardhat compile` etc. don't.
    console.warn('[hardhat] PRIVATE_KEY is not set in .env — deployments will fail');
}

const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon-rpc.com';
const SONIC_RPC   = process.env.SONIC_RPC   || 'https://rpc.soniclabs.com';
const GNOSIS_RPC  = process.env.GNOSIS_RPC  || 'https://gnosis-rpc.publicnode.com';

// Only pass an accounts array when the key is actually present, otherwise
// hardhat throws on load. This lets `hardhat compile` work with no .env.
const accounts = PRIVATE_KEY ? [PRIVATE_KEY as `0x${string}`] : [];

export default defineConfig({
    // Hardhat 3: plugins must be registered explicitly, not just imported.
    plugins: [HardhatIgnitionViem],
    defaultNetwork: "polygon",
    networks: {
        polygon: {
            url: POLYGON_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        sonic: {
            url: SONIC_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        gnosis: {
            url: GNOSIS_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
    },
    solidity: {
        version: "0.8.0",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
        },
    },
    paths: {
        sources:   "./contracts",
        tests:     "./build/test",
        cache:     "./build/cache",
        artifacts: "./build/artifacts",
    },
    mocha: {
        timeout: 20_000,
    },
});
