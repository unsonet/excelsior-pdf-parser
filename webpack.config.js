const path = require("path");
const webpack = require("webpack");
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");
const fs = require("fs");

const workspaceRoot = path.resolve(__dirname, "../../");

function getLocalLibAliases() {
  const libsDir = path.resolve(workspaceRoot, "libs");
  const aliases = {};

  if (!fs.existsSync(libsDir)) {
    return aliases;
  }

  fs.readdirSync(libsDir).forEach((libName) => {
    const packageJsonPath = path.join(libsDir, libName, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return;
    }

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    if ("@unsonet/excelsior-pdf-parser" === pkg.name) {
      return;
    }

    let srcEntry = path.join(libsDir, libName, "src", "index.ts");
    if (!fs.existsSync(srcEntry)) {
      srcEntry = path.join(libsDir, libName, "src", "lib", "index.ts");
    }

    if (pkg.name && fs.existsSync(srcEntry)) {
      aliases[pkg.name] = srcEntry;
    }
  });

  return aliases;
}

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf-8")
);
const { version, name, license, repository, author } = packageJson;

const banner = `
  ${name} v${version}
  ${repository.url}

  Copyright (c) ${author.replace(/ *<[^)]*> */g, " ").trim()} and project contributors.

  This source code is licensed under the ${license} license found in the
  LICENSE file in the root directory of this source tree.
`;

const nodeExternals = [
  function ({ request }, callback) {
    if (/^pdfjs-dist/.test(request)) {
      return callback(null, "commonjs " + request);
    }
    callback();
  },
  {
    "@thednp/dommatrix": "commonjs @thednp/dommatrix",
    fs: "commonjs fs",
    path: "commonjs path",
  },
];

function base(isNode) {
  return {
    mode: "production",
    devtool: "source-map",
    resolve: {
      extensions: [".ts", ".js"],
      alias: {
        ...getLocalLibAliases(),
      },
      fallback: isNode
        ? { fs: false, path: false, crypto: false, stream: false }
        : { fs: false, path: false, crypto: false },
    },
    module: {
      rules: [
        {
          test: /\.m?js$/,
          resolve: { fullySpecified: false },
        },
        {
          test: /\.ts$/,
          use: {
            loader: "ts-loader",
            options: {
              transpileOnly: true,
              onlyCompileBundledFiles: true,
              compilerOptions: {
                module: "ESNext",
              },
            },
          },
          exclude: /node_modules/,
        },
      ],
    },
    plugins: [
      new webpack.DefinePlugin({
        global: "globalThis",
        process: "process",
      }),
    ],
    optimization: {
      splitChunks: false,
      runtimeChunk: false,
      moduleIds: "deterministic",
      concatenateModules: true,
      minimize: true,
      minimizer: [
        new TerserPlugin({
          extractComments: false,
        }),
      ],
    },
  };
}

const browserConfig = {
  ...base(false),
  target: "web",
  entry: {
    "excelsior-pdf-parser.min": path.resolve(__dirname, "src/lib/index.ts"),
  },
  output: {
    path: path.resolve(__dirname, "../../dist/libs/excelsior-pdf-parser/browser"),
    filename: "[name].js",
    library: {
      type: "umd",
      name: "excelsiorPdfParserModule",
    },
    globalObject: "self",
    clean: true,
    chunkLoading: false,
  },
  plugins: [...base(false).plugins, new webpack.BannerPlugin(banner)],
};

const nodeConfig = {
  ...base(true),
  target: "node18",
  entry: {
    "excelsior-pdf-parser.min": path.resolve(__dirname, "src/lib/index.ts"),
    cli: path.resolve(__dirname, "src/bin/cli.ts"),
  },
  output: {
    path: path.resolve(__dirname, "../../dist/libs/excelsior-pdf-parser/node"),
    filename: "[name].cjs.js",
    library: {
      type: "commonjs2",
    },
    globalObject: "globalThis",
    clean: true,
    chunkLoading: false,
  },
  externals: nodeExternals,
  plugins: [
    new NodePolyfillPlugin(),
    new webpack.DefinePlugin({
      global: "globalThis",
      process: "process",
      self: "globalThis",
    }),
    // CLI: shebang первой строкой + сжатый баннер
    new webpack.BannerPlugin({
      banner: `#!/usr/bin/env node\n/* ${name} v${version} | ${license} | ${repository.url} */`,
      raw: true,
      entryOnly: true,
      test: /cli\.cjs\.js$/,
    }),
    // Library: обычный многострочный баннер
    new webpack.BannerPlugin({
      banner: banner,
      entryOnly: true,
      test: /excelsior-pdf-parser\.min\.cjs\.js$/,
    }),
  ],
  optimization: {
    splitChunks: false,
    runtimeChunk: false,
    moduleIds: "deterministic",
    concatenateModules: false,
    minimize: false,
  },
};

module.exports = [browserConfig, nodeConfig];