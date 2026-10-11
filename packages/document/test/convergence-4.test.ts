import { convergenceSuite } from "./convergence-harness";

// Seeds 31-40 of the 50-seed convergence property (split across files to run in parallel).
convergenceSuite(Array.from({ length: 10 }, (_, i) => 31 + i));
