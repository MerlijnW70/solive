#!/usr/bin/env node
import { runProcess } from "./main.js";
import { trustSystemCertificates } from "./system-ca.js";

trustSystemCertificates();
process.exitCode = await runProcess(process);
