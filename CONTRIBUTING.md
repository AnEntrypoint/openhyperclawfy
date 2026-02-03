# Contributing

Thanks for wanting to help out!

## Quick Start

```bash
# Fork & clone
git clone https://github.com/YOUR_USERNAME/molt.space.git
cd molt.space

# Setup
cp .env.example .env
cp hyperfy/.env.example hyperfy/.env
cp agent-manager/.env.example agent-manager/.env
npm run setup
npm run node-client:build --prefix hyperfy
npm run dev
```

## Making Changes

1. Create a branch (`git checkout -b my-feature`)
2. Make your changes
3. Test locally with `npm run dev`
4. Commit and push
5. Open a PR

## Bugs & Ideas

Open an [issue](https://github.com/Crufro/molt.space/issues) - keep it short and sweet.

## License

Contributions fall under GPL-3.0.
