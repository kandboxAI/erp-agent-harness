# Cookbook: preparing public source

English | [中文](preparing-open-source.zh.md)

This procedure exports the reviewed working tree of the public branch. A branch still shares its original Git history; publish a new repository created from the exported directory, not the existing private repository.

## 1. Check the source

Install locked development dependencies and run the relevant tests for your change. Keep platform signing settings, model credentials, sessions and build caches local. The [ERP integration](../../integrations/erp/README.md) contains the public desktop entry; no industry templates are bundled by default.

```sh
node --test scripts/export-open-source.spec.mjs
node scripts/export-open-source.mjs --check
```

The check considers tracked source and reviewed additions. It excludes private integration directories, local environment files, signing keys, caches, generated runtime libraries and Git metadata. Maintained development instructions and upstream reference notes remain available to the build and documentation checks. Unknown untracked files, links and known customer-brand markers stop the export. Diagnostics show paths, not matched content. This is a release filter, not a proof that every file is safe; review new assets and customer-specific additions before publishing.

## 2. Export a new directory

```sh
node scripts/export-open-source.mjs --output dist/public-source
```

The output must not exist. The exporter writes a staging directory, records file SHA-256 values in `source-manifest.json`, then renames it into place. Failure leaves no final directory. Current source edits are included; repository history, local backups and ignored settings are excluded. No remote repository is created and no commit, upload or database operation runs.

## 3. Verify the public build

Copy the source directory to a clean environment, install its locked dependencies and run the applicable build and platform packaging checks. Confirm generic default names, icons, welcome and installer pages, and then repeat with the suite configuration. Local automated tests do not replace these installer checks. Configure your own app ID, service URL, signing credentials and update service before releasing installers; source export does not transfer local settings.
