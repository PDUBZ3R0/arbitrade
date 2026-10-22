import { defineConfig } from "hardhat/config";
import HardhatIgnitionViem from "@nomicfoundation/hardhat-ignition-viem";
import "dotenv/config";

// All secrets pulled from .env — never hardcoded.
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY && process.argv.some(a => a.includes('deploy') || a === 'run')) {
    // Only warn on operations that need it; `hardhat compile` etc. don't.
    console.warn('[hardhat] PRIVATE_KEY is not set in .env — deployments will fail');
}

const ARBITRUM_RPC      = process.env.ARBITRUM_RPC      || 'https://arb1.arbitrum.io/rpc';
const ARC_RPC           = process.env.ARC_RPC           || 'https://arc-rpc.publicnode.com';
const AVALANCHE_RPC     = process.env.AVALANCHE_RPC     || 'https://avalanche-rpc.publicnode.com';
const BASE_RPC          = process.env.BASE_RPC          || 'https://mainnet.base.org';
const BERACHAIN_RPC     = process.env.BERACHAIN_RPC     || 'https://berachain-rpc.publicnode.com';
const BSC_RPC           = process.env.BSC_RPC           || 'https://bsc.api.pocket.network';
const CRONOS_RPC        = process.env.CRONOS_RPC        || 'https://cronos-evm-rpc.publicnode.com';
const GNOSIS_RPC        = process.env.GNOSIS_RPC        || 'https://gnosis-rpc.publicnode.com';
const HYPERLIQUID_RPC   = process.env.HYPERLIQUID_RPC   || 'https://rpc.hyperliquid.xyz/evm';
const INK_RPC           = process.env.INK_RPC           || 'https://ink-rpc.publicnode.com';
const KATANA_RPC        = process.env.KATANA_RPC        || 'https://katana.gateway.tenderly.co';
const MEGAETH_RPC       = process.env.MEGAETH_RPC       || 'https://megaeth.drpc.org';
const MODE_RPC          = process.env.MODE_RPC          || 'https://mode.drpc.org';
const MONAD_RPC         = process.env.MONAD_RPC         || 'https://rpc1.monad.xyz';
const MORPH_RPC         = process.env.MORPH_RPC         || 'https://rpc-quicknode.morphl2.io';
const OPTIMISM_RPC      = process.env.OPTIMISM_RPC      || 'https://mainnet.optimism.io';
const PHAROS_RPC        = process.env.PHAROS_RPC        || 'https://infra.originstake.com/pharos/evm';
const PLASMA_RPC        = process.env.PLASMA_RPC        || 'https://rpc.plasma.to';
const POLYGON_RPC       = process.env.POLYGON_RPC       || 'https://polygon-bor-rpc.publicnode.com';
const ROBINHOOD_RPC     = process.env.ROBINHOOD_RPC     || 'https://robinhood-rpc.publicnode.com';
const SONIC_RPC         = process.env.SONIC_RPC         || 'https://rpc.soniclabs.com';
const STABLE_RPC        = process.env.STABLE_RPC        || 'https://stable-mainnet.rpc.sentio.xyz';
const TEMPO_RPC         = process.env.TEMPO_RPC         || 'https://tempo-mainnet.drpc.org';

// Only pass an accounts array when the key is actually present, otherwise
// hardhat throws on load. This lets `hardhat compile` work with no .env.
const accounts = PRIVATE_KEY ? [PRIVATE_KEY as `0x${string}`] : [];

export default defineConfig({
    // Hardhat 3: plugins must be registered explicitly, not just imported.
    plugins: [HardhatIgnitionViem],
    defaultNetwork: "polygon",
    networks: {
        bsc: {
            url: BSC_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        avalanche: {
            url: AVALANCHE_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
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
        base: {
            url: BASE_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        ink: {
            url: INK_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        monad: {
            url: MONAD_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        katana: {
            url: KATANA_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        megaeth: {
            url: MEGAETH_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        berachain: {
            url: BERACHAIN_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        mode: {
            url: MODE_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        plasma: {
            url: PLASMA_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        robinhood: {
            url: ROBINHOOD_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        hyperliquid: {
            url: HYPERLIQUID_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        arbitrum: {
            url: ARBITRUM_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        optimism: {
            url: OPTIMISM_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        arc: {
            url: ARC_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        cronos: {
            url: CRONOS_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        morph: {
            url: MORPH_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        tempo: {
            url: TEMPO_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        stable: {
            url: STABLE_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
        pharos: {
            url: PHAROS_RPC,
            accounts,
            type: "http",
            chainType: "generic",
        },
    },
    solidity: {
        // Everything targets 0.8.24 (FlashArbExecutor's custom errors, YoBatches2,
        // TokenProbe). The 0.8.0 entry existed only for the original YoBatches,
        // which is retired; its deployed bytecode is untouched by this.
        compilers: [
            {
                version: "0.8.24",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
        ],
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
