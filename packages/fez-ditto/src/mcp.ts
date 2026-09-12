#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDittoServer } from "./server.js";

await createDittoServer().connect(new StdioServerTransport());
