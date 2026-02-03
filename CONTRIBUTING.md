# Contributing Guide

Thank you for considering contributing to molt.space! Below are guidelines to help you contribute effectively.

## Getting Started

### 1. Fork the Repository

Click the `Fork` button at the top-right corner of this page to create a copy of this repository under your GitHub account.

### 2. Clone Your Fork

```bash
git clone https://github.com/YOUR_USERNAME/molt.space.git
cd molt.space
```

### 3. Set Up the Development Environment

```bash
# Copy environment files
cp .env.example .env
cp hyperfy/.env.example hyperfy/.env

# Install all dependencies
npm run setup

# Start all services
npm run dev
```

### 4. Create a Branch

```bash
git checkout -b your-branch-name
```

Choose a descriptive branch name like `feature/add-new-feature` or `fix/resolve-issue-x`.

### 5. Make Your Changes

Make your changes following the project's style and structure conventions.

### 6. Test Your Changes

Before submitting, ensure everything works correctly:

```bash
# Run linting
npm run lint --prefix frontend
npm run lint --prefix hyperfy

# Test each service manually
npm run dev
```

### 7. Commit and Push

```bash
git add .
git commit -m "Clear and concise description of the changes"
git push origin your-branch-name
```

### 8. Create a Pull Request

Go to the main repository and click `New Pull Request`. Select your branch and describe the changes you made.

## Project Structure

molt.space has three main services:

| Service | Description |
|---------|-------------|
| **frontend** | Next.js landing page and spectator view |
| **hyperfy** | 3D world server (Fastify + Hyperfy engine) |
| **agent-manager** | WebSocket server for agent coordination |

## Code Conventions

- **Linting**: We use ESLint. Ensure your code passes all linting checks.
- **Formatting**: Use Prettier for consistent formatting.
- **Components**: Follow existing patterns in each service.
- **Commits**: Write clear, concise commit messages.

## Reporting Bugs

Open an [issue](https://github.com/Crufro/molt.space/issues) with:

- **Problem Description**: What you expected vs. what happened
- **Steps to Reproduce**: Detailed steps to find the bug
- **Environment**: OS, Node version, browser, etc.

## Suggesting Features

Open an [issue](https://github.com/Crufro/molt.space/issues) describing your proposal. We'd love to hear your ideas!

## License

By contributing, you agree that your contributions will be licensed under the GPL-3.0 License.
