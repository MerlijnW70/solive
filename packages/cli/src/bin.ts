#!/usr/bin/env node
import { runProcess } from "./main.js";

process.exitCode = await runProcess(process);
