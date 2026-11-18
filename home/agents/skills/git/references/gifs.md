# GIF library

A set of GIFs for a PR template's GIF section, each checked to render in a GitHub PR body. `/git pr` picks one by tag, as `pr.md` says.

## Contract

- **src** is a direct Giphy media URL, `https://media.giphy.com/media/<id>/<rendition>`. GitHub serves it through its camo proxy, which refuses an image over about 5 MB. So each URL names a rendition under that cap: `giphy-downsized.gif`, or `giphy.gif` where Giphy made no downsized copy.
- **alt** says what the GIF shows. It carries no `.`, `!`, `?` or `"`, because the message hook splits sentences at end punctuation and a quote would close the attribute.
- **tags** come from the list below. Every tag has at least three GIFs.

Every URL passed the checks under § Adding a GIF on 2026-11-18.

## Tags

| Tag        | Occasion |
| ---------- | -------- |
| `shipped`  | Any change landing. The fallback when no other tag fits. |
| `feature`  | A new capability for users. |
| `first`    | A first feature, a first PR, or a new project. |
| `small`    | A one-line or tiny change, such as a typo. |
| `bug`      | A bug squashed. |
| `hotfix`   | An urgent fix, or a change that lands while things burn. |
| `deletion` | Code or files removed. |
| `cleanup`  | Tidying: dead code, lint, formatting. |
| `refactor` | Restructuring that keeps behaviour. |
| `perf`     | Faster or lighter. |
| `tests`    | Tests added or fixed. |
| `ci`       | CI turned green, a check changed, or a change approved. |
| `docs`     | Documentation. |
| `deps`     | A dependency bump or upgrade. |
| `revert`   | An undo of an earlier change. |

## Adding a GIF

1. Take the ID from the Giphy page URL, `giphy.com/gifs/<slug>-<id>`, and build `src` with the `giphy-downsized.gif` rendition.
2. Run `curl -sI <src>`. It must show `200` and `content-type: image/gif`. Giphy answers a missing rendition with a 404 that still carries a placeholder GIF, so read the status, not the image. On a 404, retry with `giphy.gif`.
3. Run `gh api markdown -f text='<img alt="t" src="<src>" width="300">'`. The returned `<img>` must carry a `camo.githubusercontent.com` URL in `src`.
4. Fetch that camo URL. It must return `200`, `image/gif`, and the origin's byte count. A 404 there means the image is over the cap.
5. Look at the GIF before you write its alt text and tags. A Giphy title or slug can misname what it shows.

## Library

| Tags                   | Alt                                                                                | Src |
| ---------------------- | ---------------------------------------------------------------------------------- | --- |
| `shipped`, `first`     | GitHub squirrel holds up a phone beside a star trophy                              | `https://media.giphy.com/media/7u0xDii57oWIYuDQ7o/giphy-downsized.gif` |
| `shipped`, `hotfix`    | Titanic sails off under the caption it's shipping time                             | `https://media.giphy.com/media/Hw8vYF4DNRCKY/giphy-downsized.gif` |
| `shipped`, `feature`   | Space shuttle lifts off the launch pad                                             | `https://media.giphy.com/media/tXLpxypfSXvUc/giphy-downsized.gif` |
| `shipped`, `ci`        | Fireworks burst across the night sky                                               | `https://media.giphy.com/media/26tOZ42Mg6pbTUPHW/giphy-downsized.gif` |
| `shipped`, `first`     | Gold confetti falls                                                                | `https://media.giphy.com/media/pDD3k9SGiyEve/giphy-downsized.gif` |
| `shipped`, `feature`   | Michael and Dwight raise the roof in The Office                                    | `https://media.giphy.com/media/lMVNl6XxTvXgs/giphy-downsized.gif` |
| `shipped`              | Jim from The Office celebrates at his desk                                         | `https://media.giphy.com/media/5wWf7GW1AzV6pF3MaVW/giphy-downsized.gif` |
| `shipped`              | The Seinfeld cast dances in a doorway                                              | `https://media.giphy.com/media/BlVnrxJgTGsUw/giphy-downsized.gif` |
| `shipped`, `deletion`  | Barack Obama drops the mic                                                         | `https://media.giphy.com/media/3o7qDSOvfaCO9b3MlO/giphy-downsized.gif` |
| `hotfix`, `shipped`    | Jack Sparrow steps off his sinking ship onto the dock                              | `https://media.giphy.com/media/o0eOCNkn7cSD6/giphy-downsized.gif` |
| `feature`              | Rachel from Friends says ta-da                                                     | `https://media.giphy.com/media/JqDeI2yjpSRgdh35oe/giphy-downsized.gif` |
| `feature`, `small`     | Pink flamingo spreads its wings for a ta-da                                        | `https://media.giphy.com/media/AqAG21uonEBwaqycfY/giphy.gif` |
| `feature`, `bug`, `ci` | Young Anakin Skywalker shouts it's working                                         | `https://media.giphy.com/media/CuMiNoTRz2bYc/giphy-downsized.gif` |
| `first`                | Toddler takes first wobbly steps                                                   | `https://media.giphy.com/media/9vFqgfGEmGh5C4E01U/giphy.gif` |
| `first`, `small`       | Lettering reads small progress is still progress                                   | `https://media.giphy.com/media/m9MaXtasxTu82sCrYW/giphy-downsized.gif` |
| `small`                | Doodle of a tiny cat in a box captioned he so smol                                 | `https://media.giphy.com/media/2AzPTrjl6sraWUdJVR/giphy.gif` |
| `bug`, `hotfix`        | Train races at a crew still fixing the track, captioned fixing a bug in production | `https://media.giphy.com/media/XjlNyeZp5lDri/giphy-downsized.gif` |
| `bug`                  | Blue cartoon cat cries happy tears over one bug fixed                              | `https://media.giphy.com/media/BJe4aOiRYDP7xOqJ9t/giphy.gif` |
| `bug`                  | Blue cartoon cat at a computer, captioned fixing one bug, creating 50 more         | `https://media.giphy.com/media/K1kl2JMIMv5TBDmC2B/giphy-downsized.gif` |
| `bug`, `tests`         | Blue cartoon cat cries happy tears because the code worked                         | `https://media.giphy.com/media/m0GnqYfAV6arWftPid/giphy-downsized.gif` |
| `bug`                  | A fly buzzes past in slow motion                                                   | `https://media.giphy.com/media/8ChhEfLkhJYje/giphy-downsized.gif` |
| `bug`, `ci`            | Man in a kitchen throws his arms up and cheers                                     | `https://media.giphy.com/media/l0IyjMoACyrgPwoMg/giphy-downsized.gif` |
| `bug`, `tests`         | Adam Sandler promises trust me, it works                                           | `https://media.giphy.com/media/Mab1lyzb70X0YiNLUj/giphy-downsized.gif` |
| `hotfix`               | Cartoon dog sips coffee in a burning room, captioned this is fine                  | `https://media.giphy.com/media/Z1BTGhofioRxK/giphy-downsized.gif` |
| `hotfix`, `deletion`   | Disaster Girl smirks in front of a burning house                                   | `https://media.giphy.com/media/WMoXAd7XBSG9y4hjkg/giphy-downsized.gif` |
| `deletion`             | Thanos snaps his fingers in the Infinity Gauntlet                                  | `https://media.giphy.com/media/LOoaJ2lbqmduxOaZpS/giphy-downsized.gif` |
| `deletion`             | Hooded figure slams a big red delete button                                        | `https://media.giphy.com/media/86jXpp2SeEvEt2bvNg/giphy.gif` |
| `deletion`             | Flamethrower blasts a fireball across a field                                      | `https://media.giphy.com/media/rOtHHB3oULnuo/giphy-downsized.gif` |
| `deletion`             | Bookshop owner in Portlandia pours gasoline to burn it all                         | `https://media.giphy.com/media/3o6nV3Zk41N8yLtKoM/giphy-downsized.gif` |
| `cleanup`, `deletion`  | Marie Kondo says this one sparks joy                                               | `https://media.giphy.com/media/PmABbbUe3IqUKSOIBV/giphy-downsized.gif` |
| `cleanup`              | Marie Kondo smiles and says I love mess                                            | `https://media.giphy.com/media/fCUCbWXe9JONVsJSUd/giphy-downsized.gif` |
| `cleanup`              | Mrs Doubtfire dances with a vacuum cleaner                                         | `https://media.giphy.com/media/3o7TKU8RvQuomFfUUU/giphy-downsized.gif` |
| `cleanup`              | Skeleton sweeps up a cluttered room                                                | `https://media.giphy.com/media/MC3jH6fgDZy92/giphy-downsized.gif` |
| `refactor`             | Bob Ross calmly paints a landscape                                                 | `https://media.giphy.com/media/IAnFwq468t5kY/giphy-downsized.gif` |
| `refactor`             | Person pulls blocks from a towering Jenga stack                                    | `https://media.giphy.com/media/3xJPYhyj34S64/giphy-downsized.gif` |
| `refactor`             | Retro title card reads refactoring legacy code                                     | `https://media.giphy.com/media/l0HlGmv4WqldO9c5y/giphy-downsized.gif` |
| `perf`                 | The Flash sprints toward the camera                                                | `https://media.giphy.com/media/ICoxhc8wGbJ8k/giphy-downsized.gif` |
| `perf`                 | Minion races down a hill on a tricycle                                             | `https://media.giphy.com/media/fBEMsUeGHdpsClFsxM/giphy.gif` |
| `perf`, `docs`         | Jim Carrey types at frantic speed                                                  | `https://media.giphy.com/media/13GIgrGdslD9oQ/giphy-downsized.gif` |
| `tests`, `ci`          | Progress ring closes on tests passed                                               | `https://media.giphy.com/media/XElmx7A6NwxEaS6TaN/giphy-downsized.gif` |
| `tests`                | Patrick Star under a giant device, captioned testing, testing                      | `https://media.giphy.com/media/l1AsJYjSxCcslp3Vu/giphy-downsized.gif` |
| `ci`                   | Traffic light shows green                                                          | `https://media.giphy.com/media/9jhuQcF26JbzJ6I34a/giphy.gif` |
| `ci`                   | Rubber stamp marks a page approved                                                 | `https://media.giphy.com/media/3kuSo744UIPJjcJUEn/giphy.gif` |
| `ci`                   | Knuckles stamps a document approved                                                | `https://media.giphy.com/media/eoFJSruUWf7qq1zNHD/giphy-downsized.gif` |
| `ci`, `deps`           | Brent Rambo gives a thumbs up at his computer                                      | `https://media.giphy.com/media/111ebonMs90YLu/giphy-downsized.gif` |
| `docs`                 | Will Smith writes in a notebook from an egg chair                                  | `https://media.giphy.com/media/13uInxupYYtNf2/giphy-downsized.gif` |
| `docs`                 | Cat types on a laptop                                                              | `https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy-downsized.gif` |
| `docs`                 | Kermit the Frog types furiously on a typewriter                                    | `https://media.giphy.com/media/6dZSMuwIZTIju/giphy-downsized.gif` |
| `docs`                 | SpongeBob reads a book in bed, wide-eyed                                           | `https://media.giphy.com/media/ETUjUH8eJ2KqKZ86ic/giphy.gif` |
| `deps`                 | Text animation reads +1 level up                                                   | `https://media.giphy.com/media/iuhDCV0gok4ToFh3Qp/giphy.gif` |
| `deps`                 | Excited baby pumps both fists                                                      | `https://media.giphy.com/media/AgrfqPt5AyiTm/giphy-downsized.gif` |
| `revert`               | Homer Simpson backs slowly into a hedge                                            | `https://media.giphy.com/media/COYGe9rZvfiaQ/giphy-downsized.gif` |
| `revert`               | Blue cartoon cat mashes Ctrl+Z                                                     | `https://media.giphy.com/media/h11fguncaLEhfFDsvN/giphy-downsized.gif` |
| `revert`               | VHS screen reads click to rewind                                                   | `https://media.giphy.com/media/lr6yksak6W7CJq3nKT/giphy-downsized.gif` |
| `revert`               | DeLorean vanishes into time in a flash of light                                    | `https://media.giphy.com/media/wR4bJk4jF5Tl6/giphy-downsized.gif` |
| `revert`               | DeLorean leaves trails of fire as it jumps through time                            | `https://media.giphy.com/media/dyiOB0Zzwf4PY8fDii/giphy-downsized.gif` |
