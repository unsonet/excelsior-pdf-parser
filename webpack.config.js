const path = require('path');
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

//import packageJson from './package.json' assert { type: 'json' };
let packageJson = require('./package.json');

module.exports = {
  entry: './src/index.ts',
  output: {
    filename: 'excelsior-pdf.umd.js',
    path: path.resolve(__dirname, 'dist'),
    library: {
      name: 'ExcelsiorPDF',
      type: 'umd',
    },
    globalObject: 'this',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    plugins: [
      new TsconfigPathsPlugin({
        configFile: path.resolve(__dirname, '../../tsconfig.base.json')
      })
    ]
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }
    ]
  },
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: {
          condition: (node, comment) => {
            // Пропускаем только многострочные комментарии с /*! в начале
            return comment.type === "comment2" && /^\!/.test(comment.value.trim());
          },
          filename: (fileData) => `${path.basename(fileData.filename)}.LICENSE.txt`,
          banner: (licenseFile) => `excelsior-pdf@${packageJson.version} License information can be found in ${licenseFile}`,
        }
      }),
    ],
  },
  mode: 'production',
  devtool: 'source-map'
};
