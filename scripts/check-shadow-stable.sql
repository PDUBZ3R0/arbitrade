-- Check whether the Shadow pairs involved in the "unknown custom error"
-- reverts are stable-curve pairs. If any show stable=1, that confirms the
-- swap-output math (constant-product only, no stableswap branch) is wrong
-- for them — see the orchestrator.log analysis this is following up on.

SELECT
    address,
    factory,
    token0,
    token1,
    fee,
    stable
FROM pairs
WHERE address IN (
    '0x0ba03d7387edf6fe1f0bc62743ceecef88250ec8',  -- #11796 final hop
    '0x7ac50ddaa098e575f3a64a22c3df459f77ac53a2',  -- #11041 first hop
    '0xfe893af2d6e3363a59974ea3ac777aa73f401481',  -- #13320 hop 2
    '0x832b7fcfdf0c9c0667ed7e8c101c09f6eca688a0'   -- #13320 hop 3
);
