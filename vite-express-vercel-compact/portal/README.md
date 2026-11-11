# Vite-Express-Vercel Starter Kit

A starter template for building and deploying a Vite + React + Express application on Vercel. This project demonstrates how to set up a full-stack JavaScript application with a modern frontend and backend.

## Table of Contents

- [What's Here?](#whats-here)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Development](#development)
- [Build](#build)
- [Configuration](#configuration)
  - [Vite Configuration](#vite-configuration)
  - [Vercel Configuration](#vercel-configuration)
  - [Custom Scripts in `package.json`](#custom-scripts-in-packagejson)
  - [Custom Scripts in `server/package.json`](#custom-scripts-in-serverpackagejson)

## What's Here?

- A minimal setup for a Vite-based React app leveraging an Express-based server.

- A simple route to show you how to connect the two ports via server proxy.

- Config changes you need to make for Vite and Vercel to make this work.

## Prerequisites

- Node.js
- npm

## Installation

1. Clone the repo:

```bash
git clone https://github.com/internetdrew/vite-express-vercel.git
cd vite-express-vercel
```

2. Install dependencies for both client and server

```bash
npm install
cd server && npm install && cd ..
```

## Development

To start the development server for both the client and the server, run:

```bash
npm run dev
```

This will concurrently start the Vite development server and the Express server.

## Build

To build the project for production, run:

```bash
npm run build
```

This will compile the TypeScript files and bundle the frontend assets.

## Configuration

These are a few configurations that get things working smoothly.

### Vite Configuration

This is located in `vite.config.ts` for customizing Vite settings.

- `proxy` ensures that any requests to `/api` will be forwarded to this address, which is where the Express server is running. Of course, you can decide your own port and improve the config to align with it.

- `changeOrigin: true` changes the origin of the request to match the target URL.

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:3000`,
        changeOrigin: true,
      },
    },
  },
});
```

### Vercel Configuration

This is located in `vercel.json` for configuring Vercel deployment settings.

- `builds` specifies how to build different parts of the application:

  - The first build step uses `@vercel/node` to handle the server-side code in `server/api/index.ts`.
  - The second build step uses `@vercel/static-build` to build the client-side code, with the output directory set to `dist`.

- `rewrites` defines how incoming requests should be handled:
  - Requests to `/api/*` are forwarded to the server-side code in `server/api/index.ts`.
  - All other requests are directed to `index.html`, allowing the client-side routing to handle them.

```json
{
  "version": 2,
  "builds": [
    {
      "src": "server/api/index.ts",
      "use": "@vercel/node"
    },
    {
      "src": "package.json",
      "use": "@vercel/static-build",
      "config": { "distDir": "dist" }
    }
  ],
  "rewrites": [
    { "source": "/api/:path*", "destination": "/server/api/index.ts" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

### Custom Scripts in `package.json`

The main `package.json` file (located at the root of the project) contains several custom scripts that manage both the client and server parts of the application. Let's break them down:

```json
"scripts": {
    "dev:client": "vite",
    "dev:server": "cd server && npm run dev",
    "dev": "concurrently \"npm run dev:client\" \"npm run dev:server\"",
    "build:client": "tsc -b && vite build",
    "build:server": "cd server && npm install && npm run build && cd ..",
    "build": "npm run build:server && npm run build:client",
    "lint": "eslint .",
    "preview": "vite preview"
  }
```

1. `"dev:client": "vite"`: This script starts the Vite development server for the client-side code.
2. `"dev:server": "cd server && npm run dev"`: This script changes to the server directory and runs the server's development script.
3. `"dev": "concurrently \"npm run dev:client\" \"npm run dev:server\""`: This script uses the [concurrently](https://www.npmjs.com/package/concurrently) package to run both the client and server development scripts simultaneously. This is what you'd typically use during development.
4. `"build:client": "tsc -b && vite build"`: This script first runs the TypeScript compiler in build mode (tsc -b) and then builds the client-side code using Vite.
5. `"build:server": "cd server && npm install && npm run build && cd .."`: This script changes to the server directory, installs dependencies, builds the server, and then returns to the root directory.
6. `"build": "npm run build:server && npm run build:client"`: This script runs both the server and client build scripts in sequence.

### Custom Scripts in `server/package.json`

Now, let's look at the scripts in the server's package.json file:

```json
  "scripts": {
    "start": "node dist/index.js",
    "dev": "nodemon --watch 'api/**/*.ts' --exec 'ts-node' api/index.ts",
    "build": "tsc",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
```

1. `"dev": "nodemon --watch 'api/**/*.ts' --exec 'ts-node' api/index.ts"`: This script uses [nodemon](https://www.npmjs.com/package/nodemon) to watch for changes in TypeScript files in the api directory and restarts the server using [ts-node](https://www.npmjs.com/package/ts-node) when changes are detected. This is used for development.

These custom scripts work together to provide a smooth development experience and build process for both the client and server parts of the application. The main `package.json` scripts orchestrate the overall build and development process, while the server `package.json` scripts handle server-specific tasks.

This should be the basics you need to get up and running. Hopefully the hours I spent circling this can help you save some time.

Happy building!
