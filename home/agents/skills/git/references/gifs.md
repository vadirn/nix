# GIF library

GIFs from merged PRs, for a PR template's GIF section. `/git pr` picks one by name, as `pr.md` says.

## Adding a GIF

Add a row with a short name and the GIF's direct link. Two kinds of link fail to render on GitHub:

- **A GIF over 5 MiB.** GitHub's image proxy refuses it, and the PR shows a broken image. `curl -sI <link>` prints its `content-length`. Klipy, the source behind Raycast's GIF search, serves full-size files only, so pick another GIF.
- **A Tenor `media1.tenor.com/m/…` link**, as copied from a tenor.com page. It returns 404 on some requests. The same GIF at `media.tenor.com/<id>/<slug>.gif`, the path without `/m/`, works.

A name carries none of `.`, `!`, `?`, `"`, `[`, `]`, `(`, `)`, `|`. The message hook splits sentences at end punctuation, and the rest break the embed or the table.

## Library

| Name                                                                                              | Link |
| ------------------------------------------------------------------------------------------------- | ---- |
| Patrick Bateman nods, captioned nice                                                              | https://static.klipy.com/ii/feea28532d9709f5128558f418c779d0/10/36/4rZGmVf9.gif |
| Michael Scott points with both hands and grins                                                    | https://static.klipy.com/ii/f87f46a2c5aeaeed4c68910815f73eaf/2f/81/WTRZe1Jj.gif |
| Goku powers up, captioned level up                                                                | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/f9/3d/ck01Ofmd.gif |
| SpongeBob walks in wearing a diving helmet                                                        | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/5c/be/VE65Yfmw.gif |
| Dwight in a red wig stares                                                                        | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/e7/26/hBRy1uGW.gif |
| Michael Scott dances in his office                                                                | https://static.klipy.com/ii/925f17378dd1893b674a723c07535afe/ad/54/EngpTIBt.gif |
| Ron Swanson says bacon                                                                            | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/66/02/1bjjBkzd.gif |
| Finn asks did I do something cool                                                                 | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/f2/9b/raIauaD0.gif |
| Mr Bean sticks his tongue out over a pile of sweets                                               | https://static.klipy.com/ii/8ce8357c78ea940b9c2015daf05ce1a5/48/a4/d8Kx7AvU.gif |
| Box stamped fragile, handle with care                                                             | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/57/c4/tcBSuCVX.gif |
| Man raises his arms, captioned buy the dip                                                        | https://static2.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/54/28/IqFAcQHw.gif |
| Man at a desk in a no t-shirt                                                                     | https://static.klipy.com/ii/f87f46a2c5aeaeed4c68910815f73eaf/72/ac/k37f47ED.gif |
| Kevin says that was a really cool move                                                            | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/73/4f/gD4dxrAg.gif |
| Scrolling green numbers                                                                           | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/de/f1/UsAf7wjc.gif |
| Michael Scott says mmm nope, don't like that                                                      | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/27/b2/BKUnuNyp.gif |
| SpongeBob tangled in a breakfast machine                                                          | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/8f/62/jC6pgQq7.gif |
| Woman on a walkie-talkie says radio check, over                                                   | https://static.klipy.com/ii/a15b48460c436e1e92c85ffc680932cc/70/c0/XxbzII6q.gif |
| Man holds a phone, captioned I wonder if it's loaded                                              | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/bf/f0/R0ZjVlPHL3jePJA8h.gif |
| Man in a suit looks sideways in a dark crowd                                                      | https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/e4/7f/rNBEf5Cnt16nupzD2b.gif |
| Man with curly hair and glasses, captioned please believe it                                      | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/54/0b/oQyeWszp.gif |
| Cat sits at a laptop, captioned refresh                                                           | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/91/d1/vnQQjYqW.gif |
| Man hooded in a dark blanket scowls                                                               | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/01/5f/8aAEqPrD.gif |
| Man holds a tablet, captioned so many choices                                                     | https://media.tenor.com/juk3OzOlAcsAAAAC/so-many-choices-marques-brownlee.gif |
| Row of Marios runs across a level                                                                 | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/18/d7/o7Bt3TgI.gif |
| Sheldon Cooper says if I were wrong I'd know it                                                   | https://static.klipy.com/ii/8ce8357c78ea940b9c2015daf05ce1a5/04/97/viKeVG2t.gif |
| Blond knight in armor smiles warmly                                                               | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/0b/67/eu7PWibo.gif |
| Man writes on a clipboard in front of a whiteboard                                                | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/b0/59/VBXeYMq8.gif |
| Tom the cat with a chef hat on his head looks away                                                | https://static.klipy.com/ii/ce286d05b8e1a47cd4f32b0e1b6dec0e/75/ba/mCkfpual.gif |
| Cartoon character in a suit walks to a podium then collapses in a ball                            | https://static.klipy.com/ii/a8ada81afc59159ea5c8927feffa2e31/34/5d/FeTu5Q31qsWINMl.gif |
| Man in a suit and red tie holds a glowing light with sparkles behind him                          | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/00/64/AYeIi1aK.gif |
| Po the panda, captioned reeviieeeewwwww                                                           | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/cd/a3/vRAP4zpJ.gif |
| Man in a tweed jacket says the results are outstanding                                            | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/f1/7c/wQ58EPVz.gif |
| Man in a striped cardigan holds a cup in an office, grinning                                      | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/a5/80/0SUybFhu.gif |
| Pale man in black stands in a workshop while another man looks on                                 | https://static.klipy.com/ii/a15b48460c436e1e92c85ffc680932cc/04/8d/IUo3BLnO.gif |
| Winnie the Pooh stretches in front of a mirror, captioned warming up                              | https://static.klipy.com/ii/71b2873e478b9d8d0482ea3ec777ba7f/6a/b5/4oyoJbJZ.gif |
| Older man in a suit with white hair, captioned why                                                | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/ed/23/96B2i7sA9Gyd6Wg.gif |
| Elmo shrugs and gestures                                                                          | https://static.klipy.com/ii/35ccce3d852f7995dd2da910f2abd795/de/5c/tQILmYLE.gif |
| Napoleon Dynamite in a polo shirt gestures                                                        | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/f2/9c/WAHk6bvq.gif |
| Man laughs behind a large video camera                                                            | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/c6/ca/vWt4GYks.gif |
| Dwight Schrute speaks at a podium and waves his hands                                             | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/b5/f1/UAGR3hPs.gif |
| Snoop Dogg in glasses, captioned fo realz                                                         | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/2d/3e/A9PPGEV9.gif |
| Man with long dark hair, captioned enough of the jibber jabber                                    | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/2b/b3/NP94fM7f1dpee.gif |
| Cat in round glasses sits at an open book                                                         | https://static.klipy.com/ii/35ccce3d852f7995dd2da910f2abd795/65/ed/Jyjj64T6.gif |
| Man in a suit says you certainly seem to know your stuff                                          | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/74/fb/XUS4mcKI.gif |
| Two men sit side by side wearing conference badges and one points                                 | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/65/19/J2AZI1MD.gif |
| Man laughs, captioned it's fine                                                                   | https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/7e/60/sjFuPcZSM1LTnx.gif |
| Vault Boy gives a thumbs up, with a mushroom cloud behind                                         | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/73/af/IkB86sni.gif |
| Green hand plugs a cord into a wall socket                                                        | https://media.tenor.com/ryxv92M_x38AAAAM/plugging-it-in-donatello.gif |
| Man in a black t-shirt asks Thursday                                                              | https://static.klipy.com/ii/a8ada81afc59159ea5c8927feffa2e31/75/8f/34QKFvg66vAF7u.gif |
| Man in a courtroom says yes your honour                                                           | https://static.klipy.com/ii/a8ada81afc59159ea5c8927feffa2e31/6a/c4/WjjY7id7VEphWlnA.gif |
| Dancers in black stand on a platform while a man joins them                                       | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/96/17/6tEqVJDi2ardnDu.gif |
| White-gloved hands hold a wooden box with a spider web on it                                      | https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/b6/00/R4QmmJwGdLTR.gif |
| Mr Bean stares wide-eyed                                                                          | https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/44/61/PQl3xb5v6sI58.gif |
| Moss from The IT Crowd grimaces, captioned ugh no                                                 | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/a0/48/iJbnTmSI.gif |
| Fiery scene with a small figure on a dark ledge                                                   | https://media.tenor.com/CgLazzbj_J4AAAAM/you-shall-not-pass-gandalf.gif |
| Man sits in a yellow field and eats                                                               | https://static.klipy.com/ii/f87f46a2c5aeaeed4c68910815f73eaf/10/8c/I5g50WW2.gif |
| Ron Burgundy blows a conch, captioned assemble                                                    | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/9e/a3/syy5KkfQ.gif |
| Moss from The IT Crowd sits at a desk with flames beside him                                      | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/ca/5e/zIZaGiRb.gif |
| Man in a suit sips from a cup, captioned you should be                                            | https://static.klipy.com/ii/8ce8357c78ea940b9c2015daf05ce1a5/6e/e7/qAfgXQ4u.gif |
| Moss from The IT Crowd sits at his desk                                                           | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/cd/d7/LNTdd98x.gif |
| Dr Frankenstein shouts, captioned he's alive                                                      | https://media.tenor.com/Js9D386Ty8cAAAAM/its-alive-gene-wilder.gif |
| Roy from The IT Crowd on the phone, captioned hello IT have you tried turning it off and on again | https://static.klipy.com/ii/f87f46a2c5aeaeed4c68910815f73eaf/dd/0b/zv9xMYSt.gif |
| Moss from The IT Crowd says oh my god                                                             | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/d9/e6/kY3QlbmW.gif |
| Man in a headband points at the camera, captioned you are next                                    | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/93/10/VrK6Rjgf.gif |
| Moss and Jen hold up a card, captioned amateur hour                                               | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/b0/09/ToWaNx2f.gif |
| Three men hold glasses, captioned look normal                                                     | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/97/e7/sHPWlVQ7naRKZIJh.gif |
| Moss sits by flames, captioned it is what it is                                                   | https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/9a/24/pRYq6vTShSt2RkvbamBi.gif |
| Man in a cravat looks startled                                                                    | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/0b/eb/u6XxjJiT.gif |
| Mr Bean raises a champagne glass and grins                                                        | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/ab/b9/JyAhMiyYJaCYjLNKqcL.gif |
| Toddler in a black t-shirt skips, captioned skip                                                  | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/d0/b1/HBugBWYv.gif |
| Man in a convertible, captioned show off                                                          | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/82/bd/xGQU1iU4.gif |
| Star Destroyer flies through space                                                                | https://static.klipy.com/ii/8ce8357c78ea940b9c2015daf05ce1a5/44/48/ozjjcS3E.gif |
| Orange kitten meows, captioned meow                                                               | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/48/e8/lJTHNACjIp4Ix.gif |
| Man in a jacket, captioned I don't like tests                                                     | https://static.klipy.com/ii/35ccce3d852f7995dd2da910f2abd795/27/49/nXzQ3Uqk.gif |
| Woman in a red jacket smiles, with Korean caption                                                 | https://static2.klipy.com/ii/f87f46a2c5aeaeed4c68910815f73eaf/90/e9/uSN2E5ed.gif |
| Man in a car looks sideways and smirks                                                            | https://static2.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/7c/41/oOTuVBlm.gif |
| Man's eyes peek over tall grass                                                                   | https://static2.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/3f/8c/NJ6fl1hp.gif |
| Man in a suit looks around confused, cut out on white                                             | https://static2.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/2d/a2/bpu6okPY.gif |
| Animated boy and girl in black and white hug                                                      | https://static2.klipy.com/ii/71b2873e478b9d8d0482ea3ec777ba7f/37/5d/N7wWRqz8.gif |
| Bearded man in a blue sweater says I don't think you're using that right                          | https://static2.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/fc/64/9UzR05nT3rgWkhl.gif |
| Woman in a headset on a radio, captioned any updates                                              | https://static.klipy.com/ii/da290b156d64898341638f3c299e7478/a8/ac/GI3VnyeC.gif |
| Woman with red hair says sehcohrity                                                               | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/75/05/6IIj0LPj.gif |
| Man walks past green dumpsters                                                                    | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/a7/ae/fqupSKb0.gif |
| White fluffy dog smiles with its tongue out                                                       | https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/1b/31/8AqVBdZM.gif |
| John Cena points, captioned do not run                                                            | https://static.klipy.com/ii/8ce8357c78ea940b9c2015daf05ce1a5/3a/90/mJVXJxrg.gif |
| South Park kids stand at lockers, captioned 67                                                    | https://static.klipy.com/ii/50d7c955398dfd7e3c8ba5281154280f/52/d6/b7RVoWTtMq6oIU218j.gif |
| Pam Beesly says they're the same picture                                                          | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/96/77/kJq82JLd.gif |
| Woman in a walk-in closet says it's all about balance                                             | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/39/83/qjYqRYWn.gif |
| SpongeBob and a purple man at a building entrance                                                 | https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/5e/ff/JAsW7hU0.gif |
| Pink Panther reads a paper behind a barrel                                                        | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/01/93/gmSmg5Gx.gif |
| Wile E Coyote stretches out with a drill at his face                                              | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/28/24/ZjGpHnZS.gif |
| Walter White, captioned nothing stops this train                                                  | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/59/22/b7v3pnbV.gif |
| Michael Scott, captioned the manager                                                              | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/4e/74/oRtkmDBH.gif |
| Cartoon hand traces a face drawing on paper                                                       | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/c2/04/63hhVhtf.gif |
| Tortoises stacked, captioned are we there yet some family vacation                                | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/a7/37/KEbTIBV7.webp |
| Stan Marsh, captioned I got a job                                                                 | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/1b/09/CsBxqnR0.gif |
| Elmo in flames, captioned upgrade                                                                 | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/d6/03/ILL2XcHP.gif |
| White cat yawns widely in an anime scene                                                          | https://static.klipy.com/ii/ce286d05b8e1a47cd4f32b0e1b6dec0e/ce/93/A4BVZFDg.gif |
| Judge Judy gestures at someone                                                                    | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/cf/a3/9eNNUdg9.gif |
| SpongeBob panics on a towel, captioned wait                                                       | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/46/0a/s95Nil5m.gif |
| Hands wrap a burrito                                                                              | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/0a/1b/ZtW5CBmH.gif |
| Kids in a toy red car, captioned they see me rollin                                               | https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/a2/91/42spV4e7fE9eJMFyoOFp.gif |
| Luffy in a straw hat, captioned don't worry                                                       | https://static.klipy.com/ii/a15b48460c436e1e92c85ffc680932cc/a6/9e/AGHLaoMZ.gif |
| Man in a dark room, captioned ok                                                                  | https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/42/48/4sKpFXKgT7yHpPaD8OB.gif |
| Fry and Leela at the ship controls, captioned fix it fix it fix it                                | https://static.klipy.com/ii/bea85337777ad0e23e63683391435543/50/95/vCszAG8Z.gif |
| Will Smith in a purple tank top, captioned run                                                    | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/c7/d7/vpuP2VkL.gif |
| Two men talk outside a house, captioned message                                                   | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/45/a1/0xP3GbCm.gif |
| Lady Gaga in a red jacket, captioned it's automatic                                               | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/12/11/qyYzEwxX.gif |
| Dwight Schrute and Michael Scott raise their hands in an office                                   | https://static.klipy.com/ii/da290b156d64898341638f3c299e7478/25/e1/cK2uN55d.gif |
| South Park man with a mug, captioned looks like we got some competition                           | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/88/13/GObbDIAq.gif |
| Two Kermits in trench coats on the moon                                                           | https://static.klipy.com/ii/8ce8357c78ea940b9c2015daf05ce1a5/68/c0/22cdacY4.gif |
| Homer Simpson at a door, captioned all I need is a title                                          | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/9c/c4/H7hs2xvjrofj5f8bQ.gif |
| Man in a sombrero puts feet up, captioned I'll allow it                                           | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/d3/fa/RjEFzEhE.gif |
| Woman gives two thumbs up in a crowd                                                              | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/e5/27/i0ND7VgD.gif |
| Sheldon Cooper holds his head at a desk                                                           | https://media0.giphy.com/media/MdGUUTVHk7s1BA5Pyk/giphy.gif |
| WALL-E scene with a foreign contaminant warning                                                   | https://media.giphy.com/media/MJHPAicQ6GaKA/giphy.gif |
| SpongeBob listens to headphones and sways                                                         | https://media4.giphy.com/media/tqfS3mgQU28ko/giphy.gif |
| Mugatu says dear god it's beautiful                                                               | https://media4.giphy.com/media/jny0iQsB2l82S4n5Af/giphy.gif |
| Minion, captioned pick me pick me pick me                                                         | https://media3.giphy.com/media/LReiKIuxL8T3f8thC0/giphy.gif |
| Bugs Bunny at bat in a baseball stadium                                                           | https://media2.giphy.com/media/xUA7be0s1t2nTT56rS/giphy.gif |
| Marie the cat from The Aristocats preens                                                          | https://media2.giphy.com/media/26ufh9clS97q1cdcQ/giphy.gif |
| Hamster looks into the camera                                                                     | https://media0.giphy.com/media/xApl4Qeg4FuUW0g7a6/giphy.gif |
| Man types at a typewriter near a window                                                           | https://media0.giphy.com/media/d3g1lkA1srw1c3Di/giphy.gif |
| Man in front of bookshelves says I'm okay with that                                               | https://media4.giphy.com/media/YkpwJ3AsUIVptZOl3i/giphy.gif |
| Woman in red, captioned time is ticking                                                           | https://media4.giphy.com/media/5q3NyUvgt1w9unrLJ9/giphy.gif |
| Sylvester the cat slides across a wooden floor                                                    | https://media4.giphy.com/media/2uwZ4xi75JhxZYeyQB/giphy.gif |
| Woman in a purple top looks at the camera, captioned it's very exclusive                          | https://media3.giphy.com/media/myeDS6IoQrnyqus91Q/giphy.gif |
| Milhouse walks through a playground past a slide                                                  | https://media2.giphy.com/media/VfyC5j7sR4cso/giphy.gif |
| Cartoon man presses his fingers to his temple and thinks                                          | https://media2.giphy.com/media/J82gnViB2YLVIbfvZo/giphy.gif |
| Grey cat dances on its hind legs with arms raised                                                 | https://media0.giphy.com/media/IRFQYGCokErS0/giphy.gif |
| Terminator says hasta la vista, baby                                                              | https://media0.giphy.com/media/3oEjHSNWEQN0DbSULu/giphy.gif |
| Ross Geller gestures with both hands in a plaid shirt                                             | https://media4.giphy.com/media/iHskdY9SMLFZuQ2u5c/giphy.gif |
| Robert Downey Jr says maaaybe                                                                     | https://media2.giphy.com/media/gZGlQX3wWAV1u/giphy.gif |
| Man in a mustard jacket and beanie shrugs with open hands                                         | https://media1.giphy.com/media/HiR2vHwG8m6DoDXQHp/giphy.gif |
| Mr Mackey says mkay                                                                               | https://media1.giphy.com/media/3Q35chD4bMtEePqr8A/giphy.gif |
| Man in goggles in a speeding blurred train                                                        | https://media1.giphy.com/media/3o6Zth7pE7aPKqAEEM/giphy.gif |
| Wavy TV color bars with static                                                                    | https://media0.giphy.com/media/11v8gJRwB2fE3u/giphy.gif |
| Jimmy Fallon asks what's the difference                                                           | https://media4.giphy.com/media/gCeh1KDeDaxGu8no4A/giphy.gif |
| Bugs Bunny runs from a start sign                                                                 | https://media4.giphy.com/media/QJvwBSGaoc4eI/giphy.gif |
| Shaun the Sheep gives a double thumbs up                                                          | https://media2.giphy.com/media/tIeCLkB8geYtW/giphy.gif |
| Man in a white suit and hat tosses an orange                                                      | https://media1.giphy.com/media/R9birtLDTVVxm/giphy.gif |
| Small parrot walks down a wooden hallway                                                          | https://media0.giphy.com/media/WxqLeRWNWB9DD1THfD/giphy.gif |
| Purple cartoon hand presses a red button, captioned abort                                         | https://media0.giphy.com/media/IzXmRTmKd0if6/giphy.gif |
| Bill Murray and a man in a street, captioned didn't we do this yesterday                          | https://media4.giphy.com/media/S9crjCfQXC78ST61iv/giphy.gif |
| Yellow-and-red bulldozer rolls through grass in SpongeBob, captioned engine roars                 | https://media4.giphy.com/media/3ohzAk3TQHu5QaCUsE/giphy.gif |
| Man in a hat on a phone, captioned confirm                                                        | https://media2.giphy.com/media/lPGDiOainoEoxMp8ik/giphy.gif |
| Michael Scott laughs, captioned when someone tells me their startup's valuation and profits tally | https://media2.giphy.com/media/MSLbVzPCsfi6AB32ee/giphy.gif |
| Mr Mackey says mm-kay                                                                             | https://media1.giphy.com/media/3o6ZsZdNs3yE5l6hWM/giphy.gif |
| Man wrapped in a blue blanket hood stares ahead                                                   | https://media3.giphy.com/media/13YfQSuNJUZFpm/giphy.gif |
| Jake Peralta says we are vibing                                                                   | https://media1.giphy.com/media/jslzBnsMtVd6UX9D0v/giphy.gif |
| Michael Scott says stop it right now                                                              | https://media0.giphy.com/media/i0xGuo4o5PutVo0imJ/giphy.gif |
| Captain Holt says hot damn                                                                        | https://media0.giphy.com/media/f3jZ8moRBbEvNJjOtu/giphy.gif |
| Women dance in a room, captioned this sparks joy                                                  | https://media0.giphy.com/media/hvRoo3YcAPUheF3MxY/giphy.gif |
| Mr Bean's red mini drives and flies off a ledge                                                   | https://media0.giphy.com/media/esIjA1qIf39za/giphy.gif |
| Man in a suit pulls boxes off archive shelves                                                     | https://media0.giphy.com/media/896NyHxKgOwc8UoIar/giphy.gif |
| Shaun the Sheep spins and lands in a yellow hard hat                                              | https://media4.giphy.com/media/f74WDV59cP0NArh8gu/giphy.gif |
| Papers thrown into the air in a living room                                                       | https://media2.giphy.com/media/vysUmffUa9o4g/giphy.gif |
| Psychedelic colorful eye artwork                                                                  | https://media1.giphy.com/media/7SKOwf1nD6j6XhfLMG/giphy.gif |
| Armored knight raises a cup then waves arms in a snowy scene                                      | https://media0.giphy.com/media/uirZilfaQk85a/giphy.gif |
| Smiling man in a maroon shirt rubs his hands by a marina                                          | https://media3.giphy.com/media/Mp4hQy51LjY6A/giphy.gif |
| Woman in a judge's robe and jabot points a finger                                                 | https://media3.giphy.com/media/2tKbtEbIEsT6NpvoUw/giphy.gif |
| SpongeBob rubs his hands together                                                                 | https://media1.giphy.com/media/26u4lOMA8JKSnL9Uk/giphy.gif |
| Homer Simpson backs into a hedge and disappears                                                   | https://media3.giphy.com/media/vNOL8dKxGXfWg/giphy.gif |
| Major Payne grins in a drill sergeant hat                                                         | https://media3.giphy.com/media/mpOehzFNxf6fe/giphy.gif |
| Man points, captioned not me watching this twice                                                  | https://media2.giphy.com/media/jxHBiBS1XE2b0Mx2D7/giphy.gif |
| Puppet monkey side-eyes the camera                                                                | https://media2.giphy.com/media/H5C8CevNMbpBqNqFjl/giphy.gif |
| Fry and Leela say fix it fix it fix it                                                            | https://media4.giphy.com/media/453QsWPQj5bsQaqp8M/giphy.gif |
| Yellow chick covers its face with dark hands                                                      | https://media2.giphy.com/media/YQbME9dBMYtkSZdQ8w/giphy.gif |
| Beavis and Butt-Head sit in a messy room with a pizza box                                         | https://media2.giphy.com/media/TmveWRNTr7rXp2lw3L/giphy.gif |
| SpongeBob struggles lifting a barbell                                                             | https://media2.giphy.com/media/3oriNZoNvn73MZaFYk/giphy.gif |
| Phoebe and Joey, captioned that is brand new information                                          | https://media1.giphy.com/media/U23WekMlGy6cImpMim/giphy.gif |
| Woman with black bob says we must continue to adapt                                               | https://media0.giphy.com/media/Tes2L7WzZyEOi8et1k/giphy.gif |
| Man and woman in a hallway smile                                                                  | https://media4.giphy.com/media/d2Z0zWe67TDcbCzC/giphy.gif |
| Woman asks can you prove that                                                                     | https://media1.giphy.com/media/BElmzuIkaUs42hG6yv/giphy.gif |
| Kevin Hart squints and looks skeptical                                                            | https://media0.giphy.com/media/Fu9EXNUgJBRBe/giphy.gif |
| Simpsons danger gauge needle rises, subtitled the Simpsons were burning Nielsen boxes in the US   | https://media0.giphy.com/media/3o6MbfihCsqYtqD0xW/giphy.gif |
| Sheldon Cooper in a ball pit says bazinga                                                         | https://media0.giphy.com/media/JrGYQZWou5Z51vNRob/giphy.gif |
| SpongeBob works by a barrel marked fiber                                                          | https://media4.giphy.com/media/xUPJPJoSHlKqTW78MU/giphy.gif |
| Danny DeVito says nope                                                                            | https://media3.giphy.com/media/wYyTHMm50f4Dm/giphy.gif |
| Man types frantically on a keyboard                                                               | https://media3.giphy.com/media/pT4pmRFs15Yg8/giphy.gif |
| Seal lies on snow and looks around                                                                | https://media3.giphy.com/media/mpAJq0BoNZbig/giphy.gif |
| Woman pins photos to a red wall of string                                                         | https://media3.giphy.com/media/Pkdkzwv2O2GFLiqW6L/giphy.gif |
| Bearded man with shaggy blond hair tilts his head                                                 | https://media3.giphy.com/media/NEvPzZ8bd1V4Y/giphy.gif |
| Cartoon character in orange climbs among pipes                                                    | https://media3.giphy.com/media/D2eqJMTJRsGCDegOhj/giphy.gif |
| Smiling man holds a power tool                                                                    | https://media2.giphy.com/media/RQMO0Lxo1r101JMlKD/giphy.gif |
| Man with a beard at a desk looks around, Severance                                                | https://media0.giphy.com/media/UVTQQKj0De4T7qbgSy/giphy.gif |
| Friends sit around a coffee table in a living room                                                | https://media0.giphy.com/media/UQOH9G2ZiNwLQ3pwJw/giphy.gif |
| The magic stamp logo rotates                                                                      | https://media.giphy.com/media/SWovUkhItBMtq7Uvdv/giphy.gif |
| Man in a suit unrolls a very long scroll                                                          | https://media4.giphy.com/media/4xWGyVKoXqg2eVCiq9/giphy.gif |
| Jake Peralta waves and says noice                                                                 | https://media2.giphy.com/media/KxiRwO7tqXCTDVKobo/giphy.gif |
| Knuckles stamps papers, captioned approved                                                        | https://media.giphy.com/media/eoFJSruUWf7qq1zNHD/giphy.gif |
| Will Ferrell winces and clenches his fist                                                         | https://media2.giphy.com/media/glvNGHmbZwgrKH4YYA/giphy.gif |
| Neon cat with colorful sunglasses                                                                 | https://media1.giphy.com/media/XajJgE2T1mVpOrIkc9/giphy.gif |
| Man in a tan suit holds papers in an office                                                       | https://media2.giphy.com/media/UyPpKZScnl7na/giphy.gif |
| Man in an orange shirt, captioned replay                                                          | https://media1.giphy.com/media/9Gqnj5KjX1UnCf2axg/giphy.gif |
| Ace Ventura peers close into the camera                                                           | https://media2.giphy.com/media/aTfyCtEfDBSlG/giphy.gif |
| Lou from Little Britain says computer says no                                                     | https://media0.giphy.com/media/utmZFnsMhUHqU/giphy.gif |
| Hand squeezes a blue googly-eyed toy                                                              | https://media0.giphy.com/media/ZHo5cnrfH5XSnHvkkf/giphy.gif |
| Ducks say here we go                                                                              | https://media0.giphy.com/media/woD3lyw4gsMBJgHlpN/giphy.gif |
| Cartman asks okay you guys all ready to rehearse                                                  | https://media2.giphy.com/media/3o6ZsTHL6T4hBkyR5C/giphy.gif |
| Penguins say move it move it                                                                      | https://static.klipy.com/ii/da290b156d64898341638f3c299e7478/a4/9f/7E8fCN7i.gif |
| Patrick Star in glasses reads a notepad                                                           | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/e5/ff/SdW0wWjp.gif |
| Two men in an office, captioned what would you say you do here                                    | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/aa/9f/9LUpeyzG.gif |
| Jim Halpert in an office, captioned transfer transfer                                             | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/8c/6d/CESLsPfv.gif |
| Orange puppet shouts I'm freee                                                                    | https://static.klipy.com/ii/c44064a00e4b7451969381d90dea1769/a0/9f/gVM0qdCt.gif |
| Terry Jeffords says Terry's touched                                                               | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/54/86/V1MkhHmO.gif |
| Donald Duck says nope                                                                             | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/1a/36/MAYGejQ2.gif |
| Alf says yuck they're stale                                                                       | https://static.klipy.com/ii/a8ada81afc59159ea5c8927feffa2e31/79/eb/1k1n553cYok1bbsMG.gif |
| Red-combed chicken squints sideways                                                               | https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/dc/e5/Tx6WhELf.gif |
| SpongeBob lies on a bed, captioned I can't do it                                                  | https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/8e/df/ZI2Kgj6n.gif |
| Cartoon duck in a green cap rubs his face                                                         | https://static.klipy.com/ii/8ce8357c78ea940b9c2015daf05ce1a5/f6/13/S8CZ2ntd.gif |
| Obey spiral target logo                                                                           | https://media2.giphy.com/media/AkHgatBIpNUR2/giphy.gif |
| SpongeBob crumples on a sandy floor                                                               | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/d1/51/IY12fu25.gif |
| Beavis says tell me what to do and I will obey                                                    | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/cb/ab/6BWjW1di.gif |
| Man in a sweater vest says it's too risky                                                         | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/54/31/wIlpJL0w.gif |
| Papers fly in a living room, captioned fine then                                                  | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/18/a4/WIi81Ahn.gif |
| Batman and Robin say to the inbox                                                                 | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/d8/b9/HkBeWDkN.gif |
| Sheen and Carl, captioned ooh conflict                                                            | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/9d/f0/DHVQFGjq.gif |
| Plankton says correct                                                                             | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/33/9f/QEKLUCJM.gif |
| Kermit holds up an instant camera                                                                 | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/64/94/TzSbDKMC.gif |
| Cartman says just picture it guys                                                                 | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/30/85/DuomLkHS.gif |
| Red demon character says oh then target acquired                                                  | https://static.klipy.com/ii/ce286d05b8e1a47cd4f32b0e1b6dec0e/52/2b/x5AVAsMj.gif |
| Two penguins walk on snow                                                                         | https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/20/42/SZMKPWfnyJR9SuQMZ.gif |
| Captain Picard walks, captioned report                                                            | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/d2/aa/y3c8IaLF.gif |
| Cat in a green vest types on a laptop                                                             | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/96/61/cdubmUSY.gif |
| Batman says don't move a muscle                                                                   | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/a0/23/dtQ1LRV9.gif |
| Walter White in a yellow suit pours liquid into a tube                                            | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/b8/7f/rynqyGGb.gif |
| Ron Burgundy says I'm kind of a big deal                                                          | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/3e/c6/HmDT9Ptt.gif |
| Man with a microphone gestures on stage                                                           | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/ee/5b/H8FrUprF.gif |
| Sokka shouts to the library                                                                       | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/b2/d2/A7k7JQjn.gif |
| Man types frantically, captioned unlimited workflows                                              | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/61/7d/0PLXsztS.gif |
| Homer Simpson at the control room panel                                                           | https://static.klipy.com/ii/a15b48460c436e1e92c85ffc680932cc/e5/9b/gn5qDTDe.gif |
| Man in a bar, captioned norm                                                                      | https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/2e/48/M7Sjb9uzoglEVRloSMi.gif |
| PC Principal in sunglasses, captioned everyone has to follow protocol                             | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/a3/4e/8jVTGtqm.gif |
| Men seated in an old courtroom as a long paper unrolls across the floor                           | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/49/c9/G1VsTiHF.gif |
| Animated Batman, captioned I forgot                                                               | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/41/f5/rE7SeENn.gif |
| Mr Bean copies from the exam paper of the man beside him                                          | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/7a/2f/xUaLaeY1.gif |
| Arnold Schwarzenegger grins in a toy store, subtitled that's                                      | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/1f/aa/ykUVai66.gif |
| Fry squints suspiciously                                                                          | https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/7e/c8/7fm0pHRo.gif |
| Palace guard in a bearskin hat trips and falls while marching past another guard                  | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/68/f8/ri34rW5NmFxXWX.gif |
| Clover and Alex from Totally Spies look shocked, captioned retreat                                | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/14/0a/pImUDpQ7.gif |
| Columbo rubs his face, captioned its a mystery                                                    | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/6a/c3/T1jBSXFZ.gif |
| Orange alien Oh from Home, captioned it is mostly marketing                                       | https://static.klipy.com/ii/a8ada81afc59159ea5c8927feffa2e31/56/64/AfxdLgEyJWD2uTwPNDUI.gif |
| SpongeBob in a chair, captioned no try again                                                      | https://static.klipy.com/ii/925f17378dd1893b674a723c07535afe/db/47/GUTp1jnp.gif |
| Woman in a grey jacket tells a seated man, subtitled seriously man just retire                    | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/df/1d/uzzNzobjCObzWJ2HxG6.gif |
| Snow White sweeps a kitchen floor                                                                 | https://media4.giphy.com/media/NHHYRm7mAUQ6Y/giphy.gif |
| Woman in a purple leather jacket covers her mouth with both hands                                 | https://media2.giphy.com/media/xeK5K1BIoTaV2/giphy.gif |
| Seth Meyers at his desk, captioned lightweight                                                    | https://media1.giphy.com/media/3ohhwvE13lHiuirMvS/giphy.gif |
| Edward Scissorhands lifts his blade hands                                                         | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/c1/1f/7qsPVc7cKGem.gif |
| South Park boys play in a sandbox beside a sandcastle                                             | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/f7/83/IUVbEQ08.gif |
| Black and white Mickey Mouse opens a door                                                         | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/bf/7a/r22y40Bi.gif |
| Minion rolls its eyes, captioned blah blah                                                        | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/e5/51/WdirM0Ox.gif |
| Woman in a white blouse flings her arm out wide                                                   | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/2a/4f/RTeewjeQ.gif |
| SpongeBob laughs, captioned forever                                                               | https://static.klipy.com/ii/ce286d05b8e1a47cd4f32b0e1b6dec0e/1f/42/7XTK24IZ.gif |
| Man in a grey shirt lifts a box at a green dumpster                                               | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/9c/25/yaFEf40Y.gif |
| Michael Scott looks amazed with his mouth open                                                    | https://static.klipy.com/ii/925f17378dd1893b674a723c07535afe/84/6a/3nR7sTJU.gif |
| Michael Scott looks up, captioned cleanup on aisle five                                           | https://static.klipy.com/ii/8ce8357c78ea940b9c2015daf05ce1a5/bd/f0/otJIqOsq.gif |
| Thanos in an orange sky, subtitled everything                                                     | https://static.klipy.com/ii/8ce8357c78ea940b9c2015daf05ce1a5/a5/b4/rhLDI3P5.gif |
| Penguin pops out of a hole beside a sign reading need save                                        | https://static.klipy.com/ii/84b4c0b02782dda9051003f9e36484ec/68/31/qyu25jUv.gif |
| SpongeBob dusts off his hands, captioned done                                                     | https://static.klipy.com/ii/35ccce3d852f7995dd2da910f2abd795/58/f3/0gwVvGuD.gif |
| Kermit the Frog studies a map                                                                     | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/e7/f8/BIj4Y58x.gif |
| Mr Mackey at his desk, captioned mmmkay                                                           | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/31/41/mtMnpQh7.gif |
| Minions on a stage, captioned ta dahh                                                             | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/ea/0d/3wHVG7Zn.gif |
| Cartoon man in a tuxedo covers his face with both hands                                           | https://static.klipy.com/ii/a15b48460c436e1e92c85ffc680932cc/6b/01/vbPmhTCm.gif |
| Bookshelf of books arranged by colour                                                             | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/a6/74/u2hO88UV.gif |
| Chi the kitten pads across a keyboard                                                             | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/a8/8d/0gdXaz47.gif |
| Dwight Schrute raises a hand, subtitled it's true                                                 | https://static.klipy.com/ii/71b2873e478b9d8d0482ea3ec777ba7f/f5/74/QbkalCXn.gif |
| Man in a blue jacket and leopard scarf as confetti falls                                          | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/4a/a5/H4NzbcAS.gif |
| Man in sunglasses dangles a gold chain at the camera                                              | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/cf/b8/RhpL81iv.gif |
| Blue bedding, then a person's legs walking across a room                                          | https://static.klipy.com/ii/bea85337777ad0e23e63683391435543/51/91/RXteXV6D.gif |
| Charlie Day paces in front of a conspiracy board                                                  | https://static.klipy.com/ii/a15b48460c436e1e92c85ffc680932cc/83/fc/ue4ubjlW.gif |
| Pug climbs stairs, captioned one step at a time                                                   | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/e0/d8/Ym8j1raC.gif |
| Owen Wilson and Vince Vaughn in Wedding Crashers, captioned you lock it up                        | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/a2/42/cyZbCOmD.gif |
| Pai Mei strokes his long white beard                                                              | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/1b/60/X64jn1Cf.gif |
| Woman with blonde hair and red lipstick smiles and waves a hand                                   | https://static.klipy.com/ii/71b2873e478b9d8d0482ea3ec777ba7f/df/7a/9adnsTYL.gif |
| Man in a green shirt sprays a can in a kitchen                                                    | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/96/40/zjgF6hXw.gif |
| Man pushes at a cracked rock wall                                                                 | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/fb/75/d9Or5Wl8.gif |
| Andy Bernard smirks, captioned nailed it                                                          | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/21/85/MkglyOPW.gif |
| Danny DeVito frowns, subtitled nope                                                               | https://static.klipy.com/ii/e1b92bb53e0c9e442408bc677a56c789/28/4d/PNM3YUmb8dJLX500Osu.gif |
| South Park kids in a school hallway, captioned 6 7                                                | https://static.klipy.com/ii/50d7c955398dfd7e3c8ba5281154280f/e1/d8/sWxOtBjrmGszrbuy.gif |
| Man in a tuxedo gestures on stage, captioned try again                                            | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/62/58/JLOSdcPr.gif |
| SpongeBob in glasses, captioned time to read                                                      | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/bf/b2/WKF5H0KQ.gif |
| Cartoon mouse covers his face with his paws                                                       | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/a9/2a/XaQICYco.gif |
| Man in a suit shrugs in front of a wall of cables                                                 | https://static.klipy.com/ii/c44064a00e4b7451969381d90dea1769/2c/70/Xz350AdS.gif |
| Black and white film woman in a gown pours champagne                                              | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/e2/02/2KUfnLSnTSLqvB8T.gif |
| Men in a panic in The Office, captioned oh my God it's happening, everybody stay calm             | https://static.klipy.com/ii/35ccce3d852f7995dd2da910f2abd795/a8/ea/lUaiv38S.gif |
| Baby Yoda looks up, subtitled tries very hard                                                     | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/69/09/SNnv3kT4.gif |
| Gandalf says you shall not pass                                                                   | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/6e/18/AdqgRQrG.gif |
| Will Smith puts on sunglasses in Men in Black                                                     | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/d2/dc/45ukLyhv.gif |
| Three men in a car laugh and cover their ears                                                     | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/08/1f/ULBQmtRX.gif |
| Dwight Schrute, captioned facts                                                                   | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/5d/4d/mibSnyrC.gif |
| Rugrats character asks about sponserberleries                                                     | https://static.klipy.com/ii/c44064a00e4b7451969381d90dea1769/f9/b7/Fi52i9KM.gif |
| Man in a car, captioned still it could be worse                                                   | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/58/1e/vG6ju0jO.gif |
| Cartoon toddler in overalls sits with his chin in his hand                                        | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/e7/5c/u8uYf0ai.gif |
| Roadside sign reading this is your sign                                                           | https://static.klipy.com/ii/35ccce3d852f7995dd2da910f2abd795/73/b8/avT5HCJI.gif |
| Two men look under a car's open hood on a runway                                                  | https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/19/65/kNXLz2gG.gif |
| Woman in a waiter's vest, captioned let me make it simple for you                                 | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/3b/06/WaoUiAJl.gif |
| Darryl and Jim from The Office sit side by side                                                   | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/36/e9/NFQQw76D.gif |
| Jake Peralta in a leather jacket, captioned cool cool cool                                        | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/07/df/1q1remHC.gif |
| Penguin pops out of a hole beside a sign reading follow the rules                                 | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/eb/7b/UmgdA8KT.gif |
| Ned Flanders points, captioned okily dokily                                                       | https://static.klipy.com/ii/84b4c0b02782dda9051003f9e36484ec/6a/3a/Mw9GubVu.gif |
| Nacho Libre asks but why                                                                          | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/ea/22/Xt2KAb4k.gif |
| Michael Scott on the phone, captioned why don't you explain this to me like I'm five              | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/8d/8d/PaGRiNQz.gif |
| Woman with blonde hair, captioned no rules                                                        | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/72/49/pQCSZW2j.gif |
| Man in a purple hoodie shrugs with open hands                                                     | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/58/43/A9yTh6ux.gif |
| Jules in Pulp Fiction, captioned English mother-fucker do you speak it                            | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/ad/62/YMBlnRPGqjSpFEFvbxT.gif |
| Willy Wonka shouts you get nothing                                                                | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/93/0b/Y3YM7jlW.gif |
| Michael Scott, subtitled sometimes I'll start a sentence and I don't even know where it's going   | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/df/b9/r3bsvwlz.gif |
| Sheldon on a couch, captioned I'm Batman ssshh                                                    | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/10/d3/CD6LFixOuS4j.gif |
| Man in purple lies on a couch, captioned why would you say that                                   | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/53/e0/hmOXv11R.gif |
| Morty looks up with wide eyes                                                                     | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/a0/f3/QBBlhjzM.gif |
| Bicycle pedals and chain turning                                                                  | https://static.klipy.com/ii/bea85337777ad0e23e63683391435543/e4/38/GOwIyXaB.gif |
| Sheldon smiles at his phone                                                                       | https://static.klipy.com/ii/c44064a00e4b7451969381d90dea1769/32/5c/qVeIi8hx.gif |
| Patrick at a workbench, captioned I just build stuff                                              | https://static.klipy.com/ii/bea85337777ad0e23e63683391435543/78/6f/odTMOLUq.gif |
| Leeloo in The Fifth Element holds up a card, captioned multipass                                  | https://static.klipy.com/ii/263d75c9c6d04df878152f91dbffb873/e0/87/WFBLQq2A.gif |
| Michael Scott, subtitled oh okay                                                                  | https://static.klipy.com/ii/f87f46a2c5aeaeed4c68910815f73eaf/f8/e6/v6zNU9l0.gif |
| Barney Stinson raises a hand, captioned self five                                                 | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/ed/66/VcXeVj2e.gif |
| Bob Belcher gestures with open arms                                                               | https://static.klipy.com/ii/925f17378dd1893b674a723c07535afe/77/17/RdRDSi8R.gif |
| Barney Stinson, captioned wait for it and I hope you're not lactose intolerant                    | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/9a/5a/2BbJxDgv.gif |
| Rosa Diaz, subtitled just smack him hard                                                          | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/99/00/0IAmAdPx.gif |
| James Harden on a basketball court looks into the camera                                          | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/3d/80/PIIWeGRG.gif |
| Woman in a police uniform, captioned clearly                                                      | https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/94/de/zcm5bxVMSm9dkeiRTJSp.gif |
| Michael Scott, captioned I am dead inside                                                         | https://static.klipy.com/ii/35ccce3d852f7995dd2da910f2abd795/3d/3c/sw6JOCrq.gif |
| Tina and Louise Belcher, captioned hash isn't that illegal                                        | https://static.klipy.com/ii/925f17378dd1893b674a723c07535afe/f5/22/e72MsMzS.gif |
| Man in a white shirt and tie looks thrilled                                                       | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/41/65/PvoGRSiB.gif |
| Man in a black shirt holds a notebook in an office                                                | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/fb/06/H9F70fKN.gif |
| Woman in sunglasses eats popcorn                                                                  | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/ef/03/bKlqjS7E.gif |
| Hackerman, captioned with his name                                                                | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/3f/9b/SVlGlKU3.gif |
| Women on a couch cheer, subtitled yay                                                             | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/4b/42/7SmCX8VH.gif |
| Jake Peralta, captioned noice                                                                     | https://static.klipy.com/ii/d6b0ce929193df3c242ac34b5654d2ce/28/da/K5nVreuO.gif |
| Ron Swanson in a woodshop                                                                         | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/32/87/4fSdOua3.gif |
| Harry Potter in flames, captioned neveerrrr                                                       | https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/51/3f/TNm5WQRo.gif |
| Man in a suit, captioned absolutely useless                                                       | https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/02/dd/KjswI64c.gif |
| Michael Scott rests his chin on his fists                                                         | https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/5a/ab/GlQgDebn.gif |
| Jeremy Clarkson, captioned oh no anyway                                                           | https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/9b/60/B0h9IRdq.gif |
| Man tumbles off a couch in an office                                                              | https://static.klipy.com/ii/f87f46a2c5aeaeed4c68910815f73eaf/ce/ce/PYKfPsvD.gif |
