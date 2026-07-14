comments. But we're not done yet because
there are a whole different set of
skills called build skills that teach
your agent how to integrate Firecrawl
into any app using the relevant SDKs and
APIs, which I'll go through in way more
detail on another video. For now, let's
focus on the core and workflow skills,
which I'll explain with a simple demo.
To get started, you'll need to run this
command, which should work in any coding
harness. But, before you hit enter,
let's actually explain what this is
doing. Now, this whole command is
designed to run in an agent. So, if you
wanted to, you could plug this straight
into Claude desktop or an equivalent,
and it should just work. The Y flag here
after npm means it's going to skip any
configuration prompts, which is useful
for an agent, but if you're a human, you
can remove it if you want. Then, it
installs the latest version of the
Firecrawl CLI in an npm-specific temp
directory, which it uses to run the init
sub command to globally install the CLI.
The all flag is used to install all
three skill segments, so core,
workflows, and build for every agent,
and the browser flag opens a browser for
you to sign in to Firecrawl if you
haven't already authenticated by putting
your API key somewhere in the shell. I
tend to always do this, so I'm going to
get rid of this flag. So, after you hit
enter to install all the skills and
restart your agent harness, it should
pick them up. Note, each segment has its
own repo if you just want to install all
the skills for a specific segment, and
if you want to install an individual
skill, you can find them on the Vercel
skill site after searching for
Firecrawl. One final thing to do is to
make sure you've disabled or uninstalled
the Firecrawl plugin for Claude's code
and the MCP server so that the skills
don't clash with those tools that you've
already installed. Now, once that's
done, I can give Claude a prompt like
scrape the Vercel pricing page, and we
can see here the agent automatically
picks up on the Firecrawl scrape skill
and uses it to give me a detailed
answer. We can also ask it to search for
the latest news from Anthropic, and here
it chooses to use the Firecrawl search
skill. But, using a workflow skill is
where things start to get a bit fiddly.
So, here if I give it the prompt to
compare Stripe versus Adyen on pricing
and other things, we can see that it
does use Firecrawl, but it doesn't use
the Firecrawl specific workflow for
getting Intel. To help the agent, we can
modify the prompt to use a Firecrawl
workflow skill and then continue with
what we had before. So, now if we run
this prompt, we can see it now chooses
the Firecrawl competitive Intel skill,
which gives me a comprehensive result
getting data from live pricing, blog,
and user pages. And we can see here the
table that it shows with all the
information on this section goes all the
way down to recent strategic bets. And
if you compare it to me asking the same
prompt in regular Claude code, this
table only has four rows.
Claude even admits that the response
from Firecrawl is way more comprehensive
than the one that it provided. Let's try
