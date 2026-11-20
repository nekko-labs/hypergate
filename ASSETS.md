# Third-party assets

Things we ship that no package manager tracks. Add a row before adding the asset (see AGENTS.md, "Check the license before adding anything").

| Asset | Version / source | License | License file | Shipped in |
|---|---|---|---|---|
| Inter (Latin subset, variable 400 to 700) | rsms/inter, https://github.com/rsms/inter | SIL OFL 1.1 | `apps/site/public/fonts/Inter-OFL.txt`, `apps/web/public/fonts/Inter-OFL.txt` | site, manager |
| Space Grotesk (Latin subset, variable 400 to 700) | floriankarsten/space-grotesk, https://github.com/floriankarsten/space-grotesk | SIL OFL 1.1 | `apps/site/public/fonts/Space-Grotesk-OFL.txt`, `apps/web/public/fonts/Space-Grotesk-OFL.txt` | site, manager |
| JetBrains Mono (Latin subset, variable 400 to 500) | JetBrains/JetBrainsMono, https://github.com/JetBrains/JetBrainsMono | SIL OFL 1.1 | `apps/site/public/fonts/JetBrains-Mono-OFL.txt`, `apps/web/public/fonts/JetBrains-Mono-OFL.txt` | site, manager |

The manager serves each notice beside its font, for example `http://localhost:7777/fonts/Inter-OFL.txt`.
