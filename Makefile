.PHONY: all

all: wingmate.vsix

wingmate.vsix: package.json yarn.lock LICENSE README.md .vscodeignore out/tree-sitter-go.wasm out/tree-sitter-sql.wasm tsconfig.json src/main.ts package.json yarn.lock
	yarn --frozen-lockfile
	yarn run esbuild ./src/main.ts --bundle --outfile=out/main.js --external:vscode --format=cjs --platform=node  --sourcemap
	cp node_modules/web-tree-sitter/tree-sitter.wasm out/tree-sitter.wasm
	yarn run vsce package --yarn --out wingmate.vsix

out/tree-sitter-go.wasm: tree-sitter-go/grammar.js node_modules/tree-sitter-cli/package.json
	cd tree-sitter-go && ../node_modules/.bin/tree-sitter generate
	cd tree-sitter-go && ../node_modules/.bin/tree-sitter build-wasm --docker
	mv tree-sitter-go/tree-sitter-go.wasm out

out/tree-sitter-sql.wasm: tree-sitter-sql/grammar.js node_modules/tree-sitter-cli/package.json
	cd tree-sitter-sql && ../node_modules/.bin/tree-sitter generate
	cd tree-sitter-sql && ../node_modules/.bin/tree-sitter build-wasm --docker
	mv tree-sitter-sql/tree-sitter-sql.wasm out
