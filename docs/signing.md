# Release signing

How Hypergate's release artifacts get signed, what is already wired, and what
still needs a human with an account.

Everything below is **secret-gated**. On-demand artifact builds may remain
unsigned for local testing, but a tagged release now fails before building the
macOS jobs when any signing credential is missing. A partially configured set
also fails instead of producing a signed but unnotarized package. All secrets
live on the `nekko-labs/hypergate` repo (`gh secret set <NAME>`), and the steps
that use them are in `.github/workflows/build-artifacts.yml` and `release.yml`.

## Status at a glance

| Platform | Mechanism | Wired | Blocked on |
| --- | --- | --- | --- |
| Linux | SHA256SUMS + GPG detached signature | ✅ done, active | nothing, the key is set |
| Windows | Authenticode via Azure Artifact Signing | ✅ wired, dormant | a signing account (see the geography note) |
| macOS | Developer ID codesign + notarization | ✅ wired, dormant | Apple Developer Program enrollment |

## Linux: active now

There is no OS-level code signing on Linux; the convention is a signed checksum
file. Every release now gets:

- `SHA256SUMS`: checksums of every asset (always, no secret needed)
- `SHA256SUMS.asc`: a detached GPG signature (when `GPG_PRIVATE_KEY` is set, and it is)

The signing key was generated for this purpose on 2026-07-28 and exists in
exactly two places: the `GPG_PRIVATE_KEY` repo secret, and its public half at
[docs/release-signing-key.asc](release-signing-key.asc).

- Key: `Nekko Labs Release Signing <releases@nekkolabs.com>`, ed25519
- Fingerprint: `94C9E438A4DD9E1A5752105696C248A969F7B919`

Users verify with:

```bash
gpg --import release-signing-key.asc
gpg --verify SHA256SUMS.asc SHA256SUMS && sha256sum -c SHA256SUMS
```

If the key is ever lost or leaked, rotate: generate a new one the same way,
replace the secret and the public key file, note the change in the release
notes. (The workspace `rotate-keys` skill covers this.)

## Windows: wired, needs a signing account

The workflow signs `hypergate.exe`, `hypergated.exe` and the NSIS installer
with [Azure Artifact Signing](https://azure.microsoft.com/en-us/products/artifact-signing)
(formerly "Trusted Signing", ~$10/month) whenever the `AZURE_*` secrets exist.

**The geography catch:** public-trust Artifact Signing is currently limited to
organizations and self-employed individuals in the **US, Canada, EU and UK**.
Nekko Labs is a Japanese company, so it cannot onboard directly today. (The old
3-years-of-history requirement is gone since GA; the geo restriction is the one
that bites.)

Options, in order of recommendation:

1. **SignPath Foundation** (free, no geo restriction). SignPath gives free
   code signing to open-source projects, and Hypergate (MIT) qualifies. Apply at
   <https://signpath.org/apply>. Approval usually takes days. Their GitHub
   Action then replaces the three `azure/trusted-signing-action@v2` steps in
   `build-artifacts.yml`; the gating pattern stays identical.
2. **Azure Artifact Signing through an eligible entity**. If a US/EU entity
   ever exists (or Microsoft expands the list; track [their docs](https://learn.microsoft.com/en-us/azure/trusted-signing/)),
   set these secrets and signing turns on with no code change:
   `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (an app
   registration with the Artifact Signing Certificate Profile Signer role),
   `AZURE_SIGNING_ENDPOINT` (e.g. `https://eus.codesigning.azure.net`),
   `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`.
3. **A traditional OV certificate** (Certum ~€90/yr has an open-source
   program and sells to Japan; SSL.com eSigner): cloud-hosted keys, CI-able,
   but paid and more setup than SignPath for the same result.

Until one of these lands, Windows users see the usual SmartScreen "unknown
publisher" warning; reputation accrues to the certificate once signing starts.

## macOS: wired, needs Apple Developer enrollment

The workflow signs both binaries with hardened runtime + timestamp, seals the
`Hypergate.app` bundle, signs the `.dmg`, notarizes it with `notarytool`, and
staples the ticket. The Node/V8 `hypergated` SEA receives
`com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory`; without them,
hardened-runtime startup can fail while V8 reserves its code region. The Rust
`hypergate` shell is signed with the tighter default entitlements because it
does not JIT. The source plist is
`packaging/installers/macos/hypergate-daemon.entitlements.plist`; the
post-signing smoke test mounts the shipped DMG, verifies the app's complete
resource seal with strict deep code-signing checks, checks both daemon
entitlements, asks Gatekeeper to assess the app, and probes `/health`. The
workflow also validates the stapled ticket and assesses the finished disk
image. It needs these secrets:

| Secret | What it is |
| --- | --- |
| `MACOS_SIGNING_CERTS_P12` | base64 of a .p12 containing the Developer ID Application cert |
| `MACOS_CERT_PASSWORD` | the .p12 password |
| `MACOS_SIGN_IDENTITY` | `Developer ID Application: <name> (<TEAMID>)` |
| `APPLE_API_KEY_P8` | App Store Connect API key file contents |
| `APPLE_API_KEY_ID` | its Key ID |
| `APPLE_API_ISSUER` | its Issuer ID |

Steps for Philip (once, ~1 hour + Apple's review time):

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/)
   ($99/yr). Enrolling as **Nekko Labs** (organization) needs a D-U-N-S number;
   enrolling as an individual is faster and fine for signing (the publisher
   string becomes your name rather than the company's).
2. In Xcode or developer.apple.com, create a **Developer ID Application**
   certificate.
3. Export it into a `certs.p12` (Keychain Access → select it → Export),
   pick a password, then:
   `base64 -i certs.p12 | gh secret set MACOS_SIGNING_CERTS_P12 -R nekko-labs/hypergate`
   and set `MACOS_CERT_PASSWORD` and the two identity strings the same way.
4. In [App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api),
   create an API key with the **Developer** role; set `APPLE_API_KEY_P8`
   (file contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
5. Cut a release. The dmg comes out signed, notarized and stapled.

The workspace `provision-keys` skill automates most of step 3–4's secret
plumbing if you'd rather run it than click.

## What about npm?

`npm publish` in the release workflow already uses `--provenance`, which gives
every package a Sigstore-backed attestation tied to the GitHub build. That's
npm's own signing story and it's active as soon as `NPM_TOKEN` exists (still
pending your `npm login` / token, tracked in TASKS.md Epic 9).
