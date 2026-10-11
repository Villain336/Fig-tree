import { convergenceSuite } from "./convergence-harness";

// Wider networks: more replicas, so more concurrent moves and deletes per sync.
convergenceSuite([101, 102, 103, 104], 5, 2500);
