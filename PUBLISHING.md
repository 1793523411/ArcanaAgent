# Publishing to npm

## Pre-publish Checklist

- [ ] Update version in `package.json`
- [ ] Run `npm run build` successfully
- [ ] Test CLI locally with `node cli.js`
- [ ] Test installation with `npm link`
- [ ] Update CHANGELOG.md (if exists)
- [ ] Commit all changes
- [ ] Create git tag

## Publishing Steps

### 1. Test Build

```bash
npm run build
```

### 2. Test CLI Locally

```bash
node cli.js
node cli.js start
node cli.js status
node cli.js stop
```

### 3. Link Locally for Testing

```bash
npm link
arcana-agent start
arcana-agent status
arcana-agent stop
npm unlink -g arcana-agent
```

### 4. Login to npm

```bash
npm login
```

### 5. Publish

```bash
# Dry run first
npm publish --dry-run

# Actually publish
npm publish
```

### 6. Verify

```bash
npm install -g arcana-agent
arcana-agent --help
```

## Version Management

```bash
# Patch release (1.0.0 -> 1.0.1)
npm version patch

# Minor release (1.0.0 -> 1.1.0)
npm version minor

# Major release (1.0.0 -> 2.0.0)
npm version major
```

## Files Included in Package

Check what will be published:

```bash
npm pack --dry-run
```

The package includes (from package.json `files` field):
- cli.js
- server/dist/
- server/public/
- README.md

## Post-publish

1. Create GitHub release
2. Update documentation
3. Announce on social media

## Troubleshooting

### "You do not have permission to publish"

Make sure you're logged in:
```bash
npm whoami
npm login
```

### Package name already exists

Change the name in package.json or use a scoped package:
```json
{
  "name": "@yourname/arcana-agent"
}
```

### Files missing from package

Check `.npmignore` and `files` field in package.json.
