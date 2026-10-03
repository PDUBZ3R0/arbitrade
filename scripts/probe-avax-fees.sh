#!/usr/bin/env bash
# Identify the fee accessor for the Avalanche factories that still need one.
#
# Pair addresses below came from the scanned PairCreated events in
# db/avalanche.sqlite, so each one genuinely belongs to its factory. Liquidity
# is irrelevant here: pairFee/swapFee/fee/getFee are config reads, so a pair
# with no reserves still returns the right answer.
#
#   ./probe-avax-fees.sh            # probe every candidate accessor
#   ./probe-avax-fees.sh iface      # ask the explorer for the real ABI instead
#
# The `iface` mode is the definitive one and needs ETHERSCAN_API_KEY (the V2
# multichain key covers Avalanche). Prefer it — it tells you the accessor's
# real name instead of guessing from a list.

set -uo pipefail
RPC="${AVAX_RPC:-https://avalanche-rpc.publicnode.com}"

# factory | a pair of that factory | label
FLDX_F=0x634e02eb048eb1b5bddc0cfdc20d34503e9b362d
FLDX_P=0x7fe7277fc15be3cb2cacd4562d46d36a9839957c   # stable=0 (volatile)
FLDX_PS=0x004f0a741166cbd87106402e87daf4716aefbdbb  # stable=1, for contrast

F85_F=0x85448bf2f589ab1f56225df5167c63f57758f8c1
F85_P=0xa07182af0f7fb49b9b1ea48ea8c6bb84283a739c

HC1_F=0x7009b3619d5ee60d0665ba27cf85edf95fd8ad01
HC1_P=0x34f2284b2da33c0db1ded9dfe5a900f4a86c22b1
HC2_F=0x8e6f4af0b6c26d16febdd6f28fa7c694bd49c6bf
HC2_P=0xce1cf707c3be3c7304cc00ee277f99be3706f2ec

AAA_F=0xaaa16c016bf556fcd620328f0759252e29b1ab57
AAA_P=0xaaa3f202babcf7d6493afbc0caee03af9c64f984   # stable=0
C62_F=0xc62ca231cd2b0c530c622269da02374134511a36
C62_P=0xb5a2daf9a1af0a50d5e6489201854830264220fb   # stable=0

try() {  # try <label> <target> <sig> [args...]
  local label="$1" target="$2" sig="$3"; shift 3
  local out
  if out=$(cast call "$target" "$sig" "$@" --rpc-url "$RPC" 2>&1); then
    printf '  %-46s %s\n' "$label" "${out:-<empty>}"
  else
    printf '  %-46s --\n' "$label"
  fi
}

if [ "${1:-probe}" = "iface" ]; then
  for pair in "FLDX factory:$FLDX_F" "FLDX pair:$FLDX_P" "85448bf2 factory:$F85_F" \
              "85448bf2 pair:$F85_P" "HcSwap pair:$HC1_P"; do
    echo "=== ${pair%%:*} (${pair##*:}) ==="
    cast interface "${pair##*:}" --chain 43114 2>&1 | grep -iE \
      'fee|stable|crossPair|getReserves|swap\(' || echo '  (no ABI / no matching members)'
    echo
  done
  exit 0
fi

echo "RPC: $RPC"

echo
echo "### FldxFactory_634e02eb — the blocker. None of the registered accessors matched."
echo "# current config (group default) — expected to fail, this is what aborted reserves:"
try "factory.getRealFee(pair)" "$FLDX_F" "getRealFee(address)(uint256)" "$FLDX_P"
echo "# zero-arg getters on the pair:"
for fn in fee swapFee pairFee feeRate getFee; do
  try "pair.$fn()" "$FLDX_P" "$fn()(uint256)"
done
echo "# factory getters keyed on the pair:"
for fn in pairFee getFee getRealFee getPairFee tradingFees volatileFee stableFee; do
  try "factory.$fn(pair)" "$FLDX_F" "$fn(address)(uint256)" "$FLDX_P"
done
echo "# factory getters keyed on the stable flag (volatile=false, then stable=true):"
for fn in getFee getRealFee pairFee; do
  try "factory.$fn(false)" "$FLDX_F" "$fn(bool)(uint256)" false
  try "factory.$fn(true)"  "$FLDX_F" "$fn(bool)(uint256)" true
done
echo "# plain factory-level fee settings:"
for fn in volatileFee stableFee fee feeRate; do
  try "factory.$fn()" "$FLDX_F" "$fn()(uint256)"
done
echo "# sanity: is the pair the shape we think it is?"
try "pair.stable()" "$FLDX_P" "stable()(bool)"
try "pair.getReserves()" "$FLDX_P" "getReserves()(uint256,uint256,uint256)"
echo "# a stable pair, for contrast (fees usually differ):"
try "stablePair.fee()" "$FLDX_PS" "fee()(uint256)"
try "stablePair.stable()" "$FLDX_PS" "stable()(bool)"

echo
echo "### Factory_85448bf2 — confirm factory.pairFee(pair); expect ~3000-10000 at 1e6"
try "factory.pairFee(pair)" "$F85_F" "pairFee(address)(uint256)" "$F85_P"
try "pair.fee()  [the unverified alternative]" "$F85_P" "fee()(uint256)"
try "pair.stable()" "$F85_P" "stable()(bool)"

echo
echo "### HcSwap — is crossPair a PUBLIC getter? If yes, the exact 0.003/0.005 split is doable"
try "pair1.crossPair()" "$HC1_P" "crossPair()(bool)"
try "pair2.crossPair()" "$HC2_P" "crossPair()(bool)"
try "pair1.fee()" "$HC1_P" "fee()(uint256)"

echo
echo "### Pre-flight the solidly factories that have NOT aborted yet"
echo "# PairFactory_aaa16c01: config says getFee(bool stable, bool degen) / 10000"
try "pair.degen()" "$AAA_P" "degen()(bool)"
try "factory.getFee(false,false)" "$AAA_F" "getFee(bool,bool)(uint256)" false false
try "factory.getFee(false)" "$AAA_F" "getFee(bool)(uint256)" false
echo "# BaseV1Factory_c62ca231: config says pair.swapFee() / 1e6"
try "pair.swapFee()" "$C62_P" "swapFee()(uint256)"
try "pair.stable()" "$C62_P" "stable()(bool)"

echo
echo "Reading the numbers: divide by the scale to get a decimal fee."
echo "  3000 / 1e6 = 0.003    30 / 1e4 = 0.003    3e15 / 1e18 = 0.003"
echo "CAREFUL — original Solidly returns a DIVISOR, not a numerator:"
echo "  'amountIn -= amountIn / fee' with fee=2000 means 0.05%, i.e. 1/2000."
echo "  The config schema only does raw/feeDivisor, so if the value looks like"
echo "  2000 or 10000 and raw/scale gives an absurd fee, that is why -- and it"
echo "  also explains why interface-probe rejected it as out-of-band."
