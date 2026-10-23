#!/usr/bin/env node
import { runProcess } from "./main.js";
import { quietWebCryptoWarnings } from "./node-warnings.js";
import { trustSystemCertificates } from "./system-ca.js";

quietWebCryptoWarnings();
trustSystemCertificates();
process.exitCode = await runProcess(process);
