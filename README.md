# Attack Tree Assistant — MSc Dissertation

An interactive browser-based attack-tree assistant developed for my MSc Computing Science dissertation. The project explores whether software assistance can help users build more complete attack trees, identify low-value branches, and understand security threats without requiring expert-level terminology.

**Live application:** https://writban.github.io/Attack-Tree-Assistant-MSc-dissertation/

## Project goals

The dissertation centred on three practical questions:

1. Can an assistant suggest plausible attack-tree nodes that a user may have missed?
2. Can it help identify branches that are comparatively low-value or unlikely in the current scenario?
3. Can attack-tree content be communicated more clearly to non-expert users?

The resulting prototype combines an interactive attack-tree editor with suggestion, review/pruning, and explanation features.

## What the application does

- Create and edit attack-tree nodes in an interactive graph.
- Suggest potentially missing attack steps using a security knowledge base and semantic/fuzzy matching.
- Review existing nodes and flag branches that may deserve pruning or reconsideration.
- Provide plain-English explanations of attack-tree concepts and individual threats.
- Load scenario data for structured evaluation and demonstrations.
- Support study-oriented logging and controlled evaluation workflows.

## Implementation

The application is primarily a client-side JavaScript project built around an interactive graph interface. Its functionality is separated into several modules rather than being implemented as one monolithic script.

Key modules include:

- `js/app.js` — main application and attack-tree interaction logic.
- `js/kb-core.js` — knowledge-base matching and recommendation logic.
- `js/kb-semantic.js` — semantic matching support.
- `js/kb-eval.js` — recommendation/evaluation support.
- `js/kb-ui.js` — interface behaviour for the assistance layer.
- `js/study.js` — study and evaluation workflow support.
- `data/` — scenarios, configuration, and knowledge-base data.
- `woz/` — controlled Wizard-of-Oz study support used during development/evaluation.

The repository also contains the system architecture source and example attack-tree data used while developing and evaluating the prototype.

## Assistance approach

Rather than generating arbitrary attack steps, the assistant works from a curated knowledge base. Candidate nodes can be matched against the current tree through canonical names, aliases, keywords, scenario context, fuzzy matching, and semantic similarity.

The aim is not to replace security judgement. Suggestions are presented as decision support so that the user can accept, reject, or reconsider them.

## Why attack trees?

Attack trees model a security objective as a hierarchy of possible attacker actions. They are useful for threat analysis, but creating a good tree can be difficult for inexperienced users because the quality of the result depends heavily on what threats the author remembers to include and how well they understand them.

This project investigates whether lightweight assistance can reduce those barriers while keeping the user in control of the final model.

## Evaluation

The system was developed as an MSc research prototype and evaluated through user-study scenarios. The study compared users' initial attack trees with trees produced after access to the assistance features, while also collecting feedback on suggestions, pruning support, and threat explanations.

The repository includes study-oriented scenario and logging code used to support that evaluation. The application should therefore be viewed as a research prototype rather than a production threat-modelling platform.

## Running locally

The project is a browser application. A local HTTP server is recommended so that browser file-loading behaviour matches the deployed version.

For example, from the repository root:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Current limitations

- The project was designed for dissertation evaluation rather than production deployment.
- Recommendation quality depends on the coverage and quality of the underlying knowledge base.
- Threat relevance is contextual, so pruning/review output should be treated as guidance rather than an authoritative security decision.
- The application is predominantly client-side and does not provide the authentication, access-control, multi-user, or audit features expected of a production threat-modelling service.

## Skills demonstrated

- Cybersecurity threat modelling and attack trees
- JavaScript web application development
- Knowledge-base design
- Fuzzy and semantic matching
- Human-centred security tooling
- Interactive graph interfaces
- Experimental/user-study support
- Translating technical security concepts for non-expert users
