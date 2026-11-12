# Actual overhead, 2026-11-10

One author-run measurement of react-inp-blame 1.0.0 in [Actual](https://github.com/actualbudget/actual),
following the overhead section of the [protocol](protocol-2026-10-14.md). Actual's maintainers
had no part in it.

## Setup

- Actual at `6fa81d2f49b7562ec813dca72f2ebdb5ed3dc91e`. The served A/B/C builds are the functional
  pilot's builds file for file. Build manifest SHA-256:
  A `c6a1ea7200e9b26c30a9f857073115852e2128ec50342de7504dfe7ed879e22d`,
  B `d21c8133312b3a3a68eace787872d9601bd7ec0d803a9b385f8847cb766cf401`,
  C `56d7874031329d65cf19d583d1e52baba8be08eea18c09fe33598115bd12758d`.
- react-inp-blame 1.0.0, integrity
  `sha512-wEQcaqyjZaZ6rnIC7vqkK3eSX4Zl9Y1wBlIFjg1LlfwcsLmsU5li0gBtzxlXhEwiSFnRSU/arBduorTMltkgJg==`. The installed copy matched the npm
  tarball when those builds were made.
- Harness at `40cbd17`. Command: `node bench.mjs --app actual --blocks 5`.
- Node 24.22.2, Playwright 1.59.1, Chromium 156.0.8078.4, Ubuntu 26.04, AMD EPYC 9354P with 8
  logical CPUs and 31 GiB.
- Five balanced blocks of all six A/B/C orders at 1x and 4x CPU, one discarded warmup per
  configuration, a fresh browser context and demo budget reset for every run. Every completed run asserted
  all 20 [cases](../../bench/adapters/actual.cases.json) changed the intended state.
- 180 runs planned, 178 completed, no page or observer errors. Raw results SHA-256
  `60e1a5532e6ecabd44256d4b249870dbeab7dfa4be3dc45c44d3c0a498297aae`.
- The machine was shared. The 1-minute load average was 3.3 to 16.1 (median 5.6) during the 1x
  pass and 1.4 to 10.4 (median 3.8) during the 4x pass. Pairing by block cancels most of that
  drift, but the absolute medians move with it.

## Results

Each cell is the median paired difference against A with its 95% bootstrap interval (seed 359,
10,000 resamples). An interval that contains zero is inconclusive.
Scenario rows count only the 20 cases, not the setup clicks that build the budget. Times are in
ms.

### 1x CPU, 30 pairs

| Metric | A median | B − A | C − A |
| --- | ---: | --- | --- |
| Scenario INP estimate | 164.0 | +4.0 [-8.0, 16.0] | 0.0 [-8.0, 16.0] |
| Scenario interaction time | 2256.0 | +4.0 [-96.0, 52.0] | **+56.0 [36.0, 144.0]** |
| Scenario long-task blocking | 322.5 | -2.5 [-40.5, 39.5] | +25.5 [-13.5, 40.5] |
| Scenario LoAF blocking | 336.2 | -6.2 [-65.5, 35.7] | +6.0 [-50.8, 49.2] |
| Load to ready | 4910.5 | +9.0 [-455.0, 564.0] | -17.0 [-471.5, 397.5] |
| Whole-run INP | 136.0 | -8.0 [-12.0, 4.0] | 0.0 [-8.0, 8.0] |
| Whole-run interaction time | 3304.0 | +20.0 [-84.0, 96.0] | **+92.0 [20.0, 156.0]** |
| Delivered JS, gzip | 2090.1 KB | **+89.1 KB** | **+97.0 KB** |

### 4x CPU, 29 pairs for B and 28 for C

| Metric | A median | B − A | C − A |
| --- | ---: | --- | --- |
| Scenario INP estimate | 792.0 | +24.0 [-32.0, 64.0] | **+48.0 [4.0, 72.0]** |
| Scenario interaction time | 10864.0 | **+184.0 [32.0, 672.0]** | +500.0 [-240.0, 708.0] |
| Scenario long-task blocking | 8583.0 | **+232.0 [57.0, 622.0]** | +456.0 [-344.0, 687.0] |
| Scenario LoAF blocking | 8685.1 | **+208.3 [64.3, 628.2]** | +378.0 [-456.0, 667.3] |
| Load to ready | 8150.0 | +18.0 [-273.0, 707.0] | **+673.5 [324.0, 887.0]** |
| Whole-run INP | 704.0 | **+24.0 [8.0, 48.0]** | +32.0 [-4.0, 48.0] |
| Whole-run interaction time | 14592.0 | **+488.0 [224.0, 816.0]** | **+812.0 [152.0, 1120.0]** |
| Delivered JS, gzip | 2090.1 KB | **+89.1 KB** | **+97.0 KB** |

At 1x, B has no measurable timing cost in any row. C adds 56 ms of scenario interaction time over
the 20 cases, about 2.5%. At 4x, B adds 184 ms of scenario interaction time (1.7%) and C adds 48
ms to the scenario INP estimate (6%) and 674 ms to load to ready (8%). The library adds 89 KB of
gzipped JS, 97 KB with the overlay, about 4.5% of what Actual already sends.

The library's own `stats()` put its tree walks at a median of 299 ms per run for B at 1x and
1215 ms at 4x, counted over the whole run including setup.

## Run notes

- 4x slows the page's main thread only. For each of Actual's three workers Chromium 156 answers
  "Operation is only supported for pages, not workers", and every 4x run records it. Actual's
  backend runs in a worker, so it ran at full speed at 4x in all three configurations. The library
  runs on the main thread.
- Two 4x runs failed because the observer drain did not settle within 2000 ms: A in block 1 (BAC)
  and C in block 2 (CAB). They are kept as failures and were not rerun, so 4x is below the
  protocol's 30 pairs.
- The library bytes are checked through the builds. The installed copy had been removed from the
  Actual checkout before this run, so the run's own library check reports it missing.
- JS heap is one unforced sample at the end of a run and is not a memory result.
- One app and one build per configuration.
