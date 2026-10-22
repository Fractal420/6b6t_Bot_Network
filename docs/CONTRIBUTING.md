# Contributing to 6bBotAPI

Contributions are welcome, whether you're fixing a bug, improving existing functionality, adding tests, or correcting documentation.

## Before contributing

- Check existing issues and pull requests to avoid duplicate work.
- Discuss major features or breaking changes with the maintainers before implementing them.
- Keep each contribution focused on one logical change.

### Documentation and Maintainability

Follow the **DRY (Don't Repeat Yourself)** principle and maintain a **Single Source of Truth** throughout the repository. Avoid duplicating information across documentation, configuration files, and code. Each piece of information must have one authoritative source; other files should reference it rather than reproduce it.

Before adding documentation, check whether the information already exists in the README or another relevant file. If it does, link to the existing source instead of creating redundant content. For example, project requirements, dependency versions, and setup instructions should remain documented in one canonical location.

Keep documentation concise, organized by responsibility, and limited to what is necessary. Each file should serve a distinct purpose, making the repository easier to understand, maintain, and update.

## Workflow

1. Fork the repository and clone your fork.
2. Follow the development setup in [`README.md`](README.md).
3. Create a branch for your change:

   ```bash
   git switch -c fix/short-description
   ```

4. Make your changes and add tests where appropriate.
5. Run the relevant checks documented in the repository.
6. Commit your changes and push your branch.
7. Open a pull request against the upstream repository.

## Pull requests

Every pull request should explain:

- **What:** What changed?
- **Why:** What problem does it solve?
- **Testing:** How was the change verified?

Keep pull requests small, reviewable, and limited to their stated purpose. Update existing documentation when your changes affect documented behavior instead of creating duplicate guides.

Do not include credentials, tokens, or other private information in commits.

## Reporting bugs

Open a GitHub issue with a clear description, reproduction steps, expected behavior, and relevant error output. Remove secrets from logs before sharing them.

## Review

Maintainers may request changes before merging. Please address review feedback and keep discussions constructive.

Thank you for helping improve 6bBotAPI!
