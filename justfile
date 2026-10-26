set quiet

# the Trame checkout this plugin is composed into (its lint config, toolchain and typecheck)
trame := env("TRAME", "../trame")

default:
    just --list

# Format the backend with Trame's rustfmt settings
fmt:
    rustfmt src/mod.rs

# Rust formatting, oxlint with Trame's config, the bun tests (boundary, version, search, graph)
lint:
    rustfmt --check src/mod.rs
    {{ trame }}/node_modules/.bin/oxlint -c {{ trame }}/.oxlintrc.json web
    bun test

# Everything CI runs; the plugin must be composed into {{ trame }} (plugins.local.json + `just plugins`)
check: lint
    cd {{ trame }} && cargo clippy -p trame-local --all-targets --locked -- -D warnings
    cd {{ trame }} && cargo test -p trame-local --locked --lib local_gen::
    cd {{ trame }}/app/web && npx tsc --noEmit

# Enable the git hooks (pre-commit: `just lint`)
hooks:
    git config core.hooksPath .githooks
    echo "hooks enabled (.githooks). Bypass one with --no-verify."
