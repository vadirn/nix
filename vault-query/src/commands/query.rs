use anyhow::Result;
use std::path::Path;

use crate::base;
use crate::base::filter;
use crate::base::view;
use crate::output::Format;
use crate::vault::{self, VaultFile};

/// What a command narrows a declared view by, for values known only at call time.
///
/// Both slots are Rust closures rather than synthesized filter expressions, so
/// the `.base` grammar stays a subset of Obsidian's — see [`filter::apply`].
/// Named fields rather than two positional parameters: a call site passing two
/// bare `None`s says nothing about which slot it declined.
#[derive(Default)]
pub struct Narrowing<'a> {
    /// Run once against the whole scan, before any filtering, so a command can
    /// reject an argument that names nothing.
    ///
    /// [`Self::select`] cannot do this. A per-file predicate observes only "no
    /// file matched", which is also what a truthful empty result looks like —
    /// so a typo and a real track whose tickets are all closed are the same
    /// event to it. Separating the two is the whole reason this slot exists.
    pub precheck: Option<&'a dyn Fn(&[VaultFile]) -> Result<()>>,
    /// ANDed onto the base's declared filters, per file.
    pub select: Option<&'a dyn Fn(&VaultFile) -> bool>,
}

/// Render one view of a `.base` file, narrowed by `narrowing`.
pub fn run(
    base_path: &Path,
    view_name: &str,
    cfg: &crate::config::ResolvedConfig,
    format: Format,
    narrowing: Narrowing,
) -> Result<()> {
    let vault_root = &cfg.vault_root;
    let base_file = base::parse(base_path)?;

    let target_view = base_file
        .views
        .iter()
        .find(|v| v.name == view_name)
        .ok_or_else(|| {
            let available: Vec<&str> = base_file.views.iter().map(|v| v.name.as_str()).collect();
            anyhow::anyhow!(
                "view '{}' not found. Available: {}",
                view_name,
                available.join(", ")
            )
        })?
        .clone();

    let all_files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;

    if let Some(precheck) = narrowing.precheck {
        precheck(&all_files)?;
    }

    let mut filtered = filter::apply(
        &all_files,
        &base_file.filters,
        &target_view.filters,
        vault_root,
        narrowing.select,
    )?;

    let result = view::apply(&target_view, &base_file, &mut filtered, vault_root);
    print!("{}", result.render(&format));

    Ok(())
}
