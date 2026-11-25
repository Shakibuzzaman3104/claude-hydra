/**
 * @author Shakib
 * @since 25/11/26
 */
import { resolve } from 'node:path'

import { JsonFile } from './runtime'
import { consentFromArgs, dataDir, serve } from './server'

const consent = consentFromArgs(process.argv.slice(2), new JsonFile(resolve(dataDir, 'store.json')))
if (consent) console.log(consent)
else serve()
