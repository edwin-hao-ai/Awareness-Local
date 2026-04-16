#!/usr/bin/env node
// @ts-nocheck

// Wrapper to load the ESM entry point from CommonJS-compatible bin
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const entry = join(__dirname, 'awareness-local.mjs');
import(pathToFileURL(entry).href);
