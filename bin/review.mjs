#!/usr/bin/env node
// The `review` bin: a ~15 MB Node launcher around the real Bun entry (see launch.mjs).
import { launch } from "./launch.mjs";

await launch("src/review.tsx");
