import { createMemoryStores } from "../../../core/coordinator/data/memory_stores.js";
import { COORDINATOR } from "../fixtures.js";
import { runStoresContract } from "./stores_contract.js";

runStoresContract("memory stores", () => createMemoryStores(COORDINATOR));
