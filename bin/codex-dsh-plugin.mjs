#!/usr/bin/env node
import { pluginMain } from '../lib/plugin.js'
await pluginMain(process.argv.slice(2))
