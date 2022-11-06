.PHONY: all

all: wingmate.vsix

wingmate.vsix: out/main.js package.json yarn.lock LICENSE README.md .vscodeignore
	yarn run vsce package --yarn --out wingmate.vsix

out/main.js: tsconfig.json src/main.ts package.json yarn.lock
	yarn run tsc
