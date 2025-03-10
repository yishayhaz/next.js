const path = require('path')
const execa = require('execa')
const resolveFrom = require('resolve-from')
const ansiEscapes = require('ansi-escapes')
const fetch = require('node-fetch')

function getPromptErrorDetails(rawAssertion, mostRecentChunk) {
  const assertion = rawAssertion.toString().trim()
  const mostRecent = (mostRecentChunk || '').trim()
  return `Waiting for:\n  "${assertion}"\nmost recent chunk was:\n  "${mostRecent}"`
}

async function waitForPrompt(cp, rawAssertion, timeout = 3000) {
  let assertion
  if (typeof rawAssertion === 'string') {
    assertion = (chunk) => chunk.includes(rawAssertion)
  } else if (rawAssertion instanceof RegExp) {
    assertion = (chunk) => rawAssertion.test(chunk)
  } else {
    assertion = rawAssertion
  }

  return new Promise((resolve, reject) => {
    let mostRecentChunk = 'NO CHUNKS SO FAR'

    console.log('Waiting for prompt...')
    const handleTimeout = setTimeout(() => {
      cleanup()
      const promptErrorDetails = getPromptErrorDetails(
        rawAssertion,
        mostRecentChunk
      )
      reject(
        new Error(
          `Timed out after ${timeout}ms in waitForPrompt. ${promptErrorDetails}`
        )
      )
    }, timeout)

    const onComplete = () => {
      cleanup()
      const promptErrorDetails = getPromptErrorDetails(
        rawAssertion,
        mostRecentChunk
      )
      reject(
        new Error(
          `Process exited before prompt was found in waitForPrompt. ${promptErrorDetails}`
        )
      )
    }

    const onData = (rawChunk) => {
      const chunk = rawChunk.toString()

      mostRecentChunk = chunk
      console.log('> ' + chunk)
      if (assertion(chunk)) {
        cleanup()
        resolve()
      }
    }

    const cleanup = () => {
      cp.stdout?.off('data', onData)
      cp.stderr?.off('data', onData)
      cp.off('close', onComplete)
      cp.off('exit', onComplete)
      clearTimeout(handleTimeout)
    }

    cp.stdout?.on('data', onData)
    cp.stderr?.on('data', onData)
    cp.on('close', onComplete)
    cp.on('exit', onComplete)
  })
}

async function main() {
  const args = process.argv
  const releaseType = args[args.indexOf('--release-type') + 1]
  const semverType = args[args.indexOf('--semver-type') + 1]
  const isCanary = releaseType !== 'stable'

  if (releaseType !== 'stable' && releaseType !== 'canary') {
    console.log(`Invalid release type ${releaseType}, must be stable or canary`)
    return
  }
  if (!isCanary && !['patch', 'minor', 'stable'].includes(semverType)) {
    console.log(
      `Invalid semver type ${semverType}, must be one of ${semverType.join(
        ', '
      )}`
    )
    return
  }

  const githubToken = process.env.RELEASE_BOT_TOKEN

  if (!githubToken) {
    console.log(`Missing RELEASE_BOT_TOKEN`)
    return
  }

  const configStorePath = resolveFrom(
    path.join(process.cwd(), 'node_modules/release'),
    'configstore'
  )
  const ConfigStore = require(configStorePath)

  const config = new ConfigStore('release')
  config.set('token', githubToken)

  await execa(
    `git remote set-url origin https://vercel-release-bot:${githubToken}@github.com/vercel/next.js.git`,
    { stdio: 'inherit', shell: true }
  )
  await execa(`git config user.name "vercel-release-bot"`, {
    stdio: 'inherit',
    shell: true,
  })
  await execa(`git config user.email "infra+release@vercel.com"`, {
    stdio: 'inherit',
    shell: true,
  })

  console.log(`Running pnpm release-${isCanary ? 'canary' : 'stable'}...`)
  const child = execa(`pnpm release-${isCanary ? 'canary' : 'stable'}`, {
    stdio: 'pipe',
    shell: true,
  })

  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)

  if (isCanary) {
    console.log("Releasing canary: enter 'y'\n")
    child.stdin.write('y\n')
  } else {
    console.log('Wait for the version prompt to show up')
    await waitForPrompt(child, 'Select a new version')
    console.log('Releasing stable')
    if (semverType === 'minor') {
      console.log('Releasing minor: cursor down > 1\n')
      child.stdin.write(ansiEscapes.cursorDown(1))
    }
    if (semverType === 'major') {
      console.log('Releasing major: curser down > 1')
      child.stdin.write(ansiEscapes.cursorDown(1))
      console.log('Releasing major: curser down > 2')
      child.stdin.write(ansiEscapes.cursorDown(1))
    }
    if (semverType === 'patch') {
      console.log('Releasing patch: cursor stay\n')
    }
    console.log('Enter newline')
    child.stdin.write('\n')
    await waitForPrompt(child, 'Changes:')
    console.log('Enter y')
    child.stdin.write('y\n')
  }
  console.log('Await child process...')
  await child
  console.log('Release process is finished')

  if (isCanary) {
    try {
      const ghHeaders = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      }
      let { version } = require('../lerna.json')
      version = `v${version}`

      let release
      let releasesData

      // The release might take a minute to show up in
      // the list so retry a bit
      for (let i = 0; i < 6; i++) {
        try {
          const releaseUrlRes = await fetch(
            `https://api.github.com/repos/vercel/next.js/releases`,
            {
              headers: ghHeaders,
            }
          )
          releasesData = await releaseUrlRes.json()

          release = releasesData.find((release) => release.tag_name === version)
        } catch (err) {
          console.log(`Fetching release failed`, err)
        }
        if (!release) {
          console.log(`Retrying in 10s...`)
          await new Promise((resolve) => setTimeout(resolve, 10 * 1000))
        }
      }

      if (!release) {
        console.log(`Failed to find release`, releasesData)
        return
      }

      const undraftRes = await fetch(release.url, {
        headers: ghHeaders,
        method: 'PATCH',
        body: JSON.stringify({
          draft: false,
          name: version,
        }),
      })

      if (undraftRes.ok) {
        console.log('un-drafted canary release successfully')
      } else {
        console.log(`Failed to undraft`, await undraftRes.text())
      }
    } catch (err) {
      console.error(`Failed to undraft release`, err)
    }
  }
}

main()
