import type { Metadata } from "next";
import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | Planbraid",
  description: "How Planbraid collects, uses, stores, shares, and protects personal information.",
  alternates: { canonical: "/privacy" },
};

const LAST_UPDATED = "August 21, 2026";

function configuredContact() {
  const value = process.env.PRIVACY_CONTACT_EMAIL?.trim() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

export default function PrivacyPolicyPage() {
  const contactEmail = configuredContact();
  const operatorName = process.env.PLANBRAID_LEGAL_NAME?.trim() || "Planbraid";

  return <main className={styles.page}>
    <header className={styles.siteHeader}>
      <a className={styles.brand} href="/" aria-label="Planbraid home"><span className={styles.logo} aria-hidden="true" />Planbraid</a>
      <a className={styles.backLink} href="/">Return to Planbraid <span aria-hidden="true">→</span></a>
    </header>

    <div className={styles.shell}>
      <aside className={styles.toc} aria-label="Privacy policy sections">
        <p>On this page</p>
        <nav>
          <a href="#scope">Scope and roles</a>
          <a href="#collect">Information we collect</a>
          <a href="#use">How we use information</a>
          <a href="#integrations">Connected services and AI agents</a>
          <a href="#disclose">How we disclose information</a>
          <a href="#retention">Retention and deletion</a>
          <a href="#rights">Your privacy rights</a>
          <a href="#security">Security and transfers</a>
          <a href="#contact">Contact us</a>
        </nav>
      </aside>

      <article className={styles.policy}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>PLANBRAID LEGAL</span>
          <h1>Privacy Policy</h1>
          <p className={styles.updated}>Effective and last updated: {LAST_UPDATED}</p>
          <p className={styles.lead}>This policy explains what information Planbraid handles, why we handle it, where it can go, and the choices available to you. It applies to the Planbraid web application, MCP service, integrations, APIs, and related support interactions.</p>
          <div className={styles.summary}>
            <strong>The short version</strong>
            <p>Planbraid stores the account, project, task, integration, and agent activity needed to maintain a shared project plan. We do not sell personal information, use it for cross-context behavioral advertising, or store full AI chat transcripts by default. Connected services only receive or expose data when you authorize and use those connections.</p>
          </div>
        </div>

        <section id="scope">
          <h2>1. Scope, operator, and privacy roles</h2>
          <p><strong>{operatorName}</strong> operates the hosted Planbraid service described by this policy. In this policy, “Planbraid,” “we,” “our,” and “us” refer to that operator.</p>
          <p>For account administration, product operations, security, and direct support, Planbraid generally determines why and how personal information is processed and acts as the controller or business. When an organization connects its workplace systems or enters information about employees, contractors, customers, or other people, that organization may be the controller or business and Planbraid may process the information on its behalf.</p>
          <p>This policy does not govern third-party products you connect to Planbraid. Atlassian, 37signals/Basecamp, Slack, Google, GitHub, AI providers, and other services process information under their own terms and privacy notices.</p>
        </section>

        <section id="collect">
          <h2>2. Information we collect</h2>
          <p>We collect information from you, your organization, connected services you authorize, agents you connect, and ordinary service operation. The exact information depends on the features you use.</p>

          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Category</th><th>Examples</th><th>Source</th></tr></thead>
              <tbody>
                <tr><td>Account and identity</td><td>Name, email address, profile image, internal user and organization identifiers, authentication method, and account settings.</td><td>You and sign-in providers such as Google.</td></tr>
                <tr><td>Authentication and connection credentials</td><td>Password verifier, session identifiers, MCP access credentials, OAuth access and refresh tokens, granted scopes, connection status, and token expiry. Planbraid does not store your plain-text account password.</td><td>You, Planbraid authentication, and services you authorize.</td></tr>
                <tr><td>Project and work content</td><td>Project names and descriptions; plans; tasks; priorities; statuses; dependencies; owners; due dates; decisions; notes; evidence; imported item descriptions; and links.</td><td>You, collaborators, connected agents, and imported work systems.</td></tr>
                <tr><td>Integration data</td><td>Connected account/site identifiers, project and issue identifiers, Jira or Basecamp item content and metadata, statuses, assignees, team-member names and avatars, Slack workspace/channel details, and delivery or webhook metadata.</td><td>Atlassian/Jira, Basecamp, Slack, GitHub, and other connections you enable.</td></tr>
                <tr><td>Agent and repository context</td><td>Agent provider/model labels, session titles, activity timestamps, task claims, coding-space identifiers, repository URL or directory fingerprints, branch and commit identifiers, changed file paths, symbol names, and verification results.</td><td>Connected MCP clients, agents, hooks, Git, and your commands.</td></tr>
                <tr><td>Device and operational data</td><td>IP address, browser and device characteristics, request timestamps, requested routes, response/error data, security events, and diagnostic logs.</td><td>Your browser/device and our hosting, security, and logging infrastructure.</td></tr>
                <tr><td>Communications</td><td>Support requests, privacy inquiries, feedback, and related correspondence.</td><td>You or an authorized organization contact.</td></tr>
              </tbody>
            </table>
          </div>

          <h3>Information Planbraid does not collect by default</h3>
          <ul>
            <li>Planbraid does not intentionally store complete Codex, Claude, ChatGPT, or other agent chat transcripts merely because an agent is connected.</li>
            <li>Planbraid does not read source-code contents through its GitHub repository picker; that feature reads repository identity and descriptive metadata. An agent may separately submit task context, paths, symbols, evidence, or other content when you direct it to use Planbraid.</li>
            <li>Planbraid does not request payment-card information through the current service and does not intentionally collect government identifiers, health information, precise geolocation, biometric templates, or other special-category data.</li>
          </ul>
          <p>Please avoid placing sensitive personal information in project descriptions, tasks, notes, imported messages, or agent prompts unless it is necessary and your organization has authorized it.</p>

          <h3>Cookies and local storage</h3>
          <p>Planbraid uses essential cookies or equivalent browser storage to authenticate sessions, maintain security, remember interface preferences such as theme, and operate requested features. We do not currently use advertising cookies or cross-site behavioral tracking. If optional analytics or marketing technologies are introduced, we will update this policy and request consent where required.</p>
        </section>

        <section id="use">
          <h2>3. How and why we use information</h2>
          <p>We use information only for legitimate product, security, support, and legal purposes, including to:</p>
          <ul>
            <li>create and administer accounts, organizations, sessions, and authorized connections;</li>
            <li>provide the project record, work-item graph, deduplication, ownership, review, notification, synchronization, and collaboration features you request;</li>
            <li>import data from connected services and return relevant project context to authorized MCP clients and agents;</li>
            <li>send project notifications to a Slack channel or another destination configured by an authorized user;</li>
            <li>authenticate requests, enforce project and organization boundaries, prevent abuse, investigate incidents, and protect the service;</li>
            <li>diagnose failures, maintain reliability, improve usability, and understand aggregate service performance;</li>
            <li>respond to support, privacy, and legal requests; and</li>
            <li>comply with law, enforce applicable agreements, and establish or defend legal claims.</li>
          </ul>

          <h3>Legal bases where GDPR or UK GDPR applies</h3>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Legal basis</th><th>Typical processing</th></tr></thead>
              <tbody>
                <tr><td>Contract</td><td>Providing and securing the account, project workspace, MCP connection, imports, synchronization, and requested notifications.</td></tr>
                <tr><td>Legitimate interests</td><td>Service security, fraud and abuse prevention, troubleshooting, product reliability, limited analytics, and protecting legal rights, balanced against user privacy.</td></tr>
                <tr><td>Consent</td><td>Connecting optional third-party accounts or any optional processing for which consent is legally required. You may withdraw consent by disconnecting the integration or contacting us, without affecting earlier lawful processing.</td></tr>
                <tr><td>Legal obligation</td><td>Responding to valid legal process, meeting recordkeeping duties, and complying with applicable law.</td></tr>
              </tbody>
            </table>
          </div>
          <p>Providing core account and project information is necessary to use Planbraid. If you do not provide it, the corresponding account, project, connection, or feature may not work.</p>
        </section>

        <section id="integrations">
          <h2>4. Connected services, workplace data, and AI agents</h2>

          <h3>Jira and Basecamp</h3>
          <p>When you authorize Jira or Basecamp, Planbraid receives OAuth credentials and reads the sites/accounts, projects, work items, statuses, descriptions, priorities, dates, relationships, and participant information available to the authorizing user. Planbraid imports selected work into its own project record.</p>
          <p>Planbraid does not create, edit, transition, archive, or delete Jira issues, Basecamp todos, or projects in those systems. It may register or renew a provider webhook or callback subscription so the provider can notify Planbraid about changes. Disconnecting an integration removes or disables Planbraid’s connection; it does not delete source data from Jira or Basecamp.</p>

          <h3>Slack and notification destinations</h3>
          <p>When you connect Slack, Planbraid can read workspace and channel metadata needed for channel selection and can post the project updates you configure. A message shortcut or command may send the selected message or entered command content to Planbraid. Planbraid does not read general channel history unless a future feature clearly requests additional permission and this policy is updated.</p>

          <h3>GitHub</h3>
          <p>When you connect GitHub, Planbraid reads the repository list and descriptive metadata made available by the GitHub App so you can associate a project with a repository. The picker does not read repository source files. Git or agent-provided evidence can still contain repository identifiers, file paths, symbols, commits, or test results.</p>

          <h3>MCP clients and AI providers</h3>
          <p>An authorized MCP client can read project context and submit plans, progress, blockers, evidence, and completion claims within its granted scope. Information returned to a connected client is then handled by that client and its AI provider under their policies and your agreement with them.</p>
          <p>Planbraid does not use private project content to train a Planbraid general-purpose AI model. Planbraid can perform automated matching, ranking, status derivation, and planning assistance, but it does not make solely automated decisions that produce legal or similarly significant effects about individuals.</p>

          <h3>Your responsibility when importing team data</h3>
          <p>If you connect a workplace project, you represent that you are authorized to connect it and process the included information. Your organization is responsible for giving appropriate notice to team members and establishing any required legal basis for importing and using their task ownership, display name, email visibility, avatar, and work activity.</p>
        </section>

        <section id="disclose">
          <h2>5. When we disclose information</h2>
          <p>We do not sell personal information. We do not share personal information for cross-context behavioral advertising. We may disclose information only as described below:</p>
          <ul>
            <li><strong>At your direction.</strong> To users, agents, MCP clients, Slack channels, or connected services you authorize, subject to project and organization access controls.</li>
            <li><strong>Service providers.</strong> To vendors that provide hosting, database, authentication, email, security, monitoring, and operational support. Depending on deployment, these may include Vercel, Neon or another configured PostgreSQL provider, and authentication providers. They may process information only to provide services to Planbraid under applicable contractual restrictions.</li>
            <li><strong>Integration providers.</strong> Atlassian, 37signals/Basecamp, Slack, Google, GitHub, and similar providers receive OAuth requests, callback data, API requests, or notifications necessary to operate a connection.</li>
            <li><strong>Your organization.</strong> Administrators and authorized members of an organization may access project information, integration state, and activity associated with that organization.</li>
            <li><strong>Legal and safety reasons.</strong> When reasonably necessary to comply with law or valid process; protect users, Planbraid, or others; investigate abuse; or establish, exercise, or defend legal claims.</li>
            <li><strong>Business changes.</strong> In connection with a merger, financing, acquisition, reorganization, or sale of assets, subject to appropriate confidentiality and notice obligations.</li>
          </ul>
          <p>We may use and disclose aggregated or de-identified information that cannot reasonably identify an individual. We do not attempt to re-identify such information except to test whether de-identification is effective or as permitted by law.</p>
        </section>

        <section id="retention">
          <h2>6. Retention, disconnection, and deletion</h2>
          <p>We keep personal information only as long as reasonably necessary for the purposes described here, including providing the service, maintaining an auditable project history, resolving disputes, enforcing agreements, meeting legal obligations, and protecting the service.</p>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Information</th><th>General retention approach</th></tr></thead>
              <tbody>
                <tr><td>Account and organization data</td><td>While the account is active and for a limited period afterward when needed for security, recovery, legal obligations, or dispute resolution.</td></tr>
                <tr><td>Project, work-item, and provenance data</td><td>Until an authorized user deletes the applicable project or account, subject to audit, backup, legal, and integrity requirements. Removing an agent card preserves historical provenance unless the underlying project/account data is deleted.</td></tr>
                <tr><td>OAuth and MCP credentials</td><td>Until revoked, disconnected, expired, replaced, or no longer required. Stored OAuth credentials are encrypted at rest; account passwords are stored as non-reversible verifiers.</td></tr>
                <tr><td>Imported provider data</td><td>Until the corresponding Planbraid project/imported records are deleted or retention is otherwise requested. Disconnecting stops future access but does not automatically erase already-imported Planbraid records.</td></tr>
                <tr><td>Security and diagnostic logs</td><td>For a limited period appropriate to troubleshooting, fraud prevention, and security, unless a longer period is required for an active incident or legal obligation.</td></tr>
                <tr><td>Backups</td><td>Until overwritten through the ordinary backup cycle. Information in backups is isolated from normal use and deleted when the backup expires, unless preservation is legally required.</td></tr>
              </tbody>
            </table>
          </div>
          <p>Deletion requests may be limited where retaining information is necessary to comply with law, protect security, prevent fraud, preserve transaction integrity, exercise legal rights, or maintain records that another authorized organization member still controls. When deletion is not immediately possible, we restrict the information from ordinary use where appropriate.</p>
        </section>

        <section id="rights">
          <h2>7. Your choices and privacy rights</h2>
          <p>Depending on where you live and subject to applicable exceptions, you may have the right to:</p>
          <ul>
            <li>request access to and a copy of personal information about you;</li>
            <li>request correction of inaccurate or incomplete information;</li>
            <li>request deletion or restriction of processing;</li>
            <li>object to processing based on legitimate interests;</li>
            <li>withdraw consent at any time where processing relies on consent;</li>
            <li>receive certain information in a portable format;</li>
            <li>know the categories, sources, purposes, and recipients of personal information;</li>
            <li>opt out of sale, cross-context behavioral advertising, or certain sharing; and</li>
            <li>exercise privacy rights without unlawful discrimination or retaliation.</li>
          </ul>
          <p>Planbraid does not currently sell personal information or share it for cross-context behavioral advertising, so there is no sale or advertising-sharing activity to opt out of. We also do not use or disclose sensitive personal information to infer characteristics about you.</p>

          <h3>How to exercise a right</h3>
          <p>Use the contact method in Section 12 and describe your request. We may need to verify your identity and authority before acting. If the information is controlled by your employer or another Planbraid customer, we may direct the request to that organization. Authorized agents may submit requests where permitted by law, subject to verification.</p>
          <p>Residents of the EEA or UK may complain to their local data-protection authority. Residents of other jurisdictions may contact the privacy or consumer-protection authority available where they live. You may also contact us first so we can try to resolve the concern.</p>

          <h3>Integration controls</h3>
          <p>You can disconnect integrations in Planbraid and may also revoke Planbraid from the connected provider’s account settings. Revocation prevents future API access but does not automatically delete data already imported into Planbraid or data retained by the provider.</p>
        </section>

        <section id="security">
          <h2>8. Security</h2>
          <p>Planbraid uses administrative, technical, and organizational safeguards designed to protect information. These include tenant-scoped authorization, authenticated sessions, scoped OAuth access, encrypted storage of third-party credentials, password hashing, token expiry and rotation, request validation, webhook verification, and audit-oriented provenance.</p>
          <p>No internet service is perfectly secure. You are responsible for protecting your credentials, limiting integration scopes and project access, and promptly revoking connections you no longer trust. If you believe your account or data has been compromised, contact us promptly.</p>

          <h2>9. International data transfers</h2>
          <p>Planbraid and its service providers may process information in countries other than where you live. Those countries may have different data-protection laws. Where required, we rely on recognized safeguards such as adequacy decisions, standard contractual clauses, or another lawful transfer mechanism.</p>

          <h2>10. Children</h2>
          <p>Planbraid is intended for professional and project-management use and is not directed to children under 13. We do not knowingly collect personal information from children under 13. Where local law requires a higher minimum age for consent to online services, users must meet that age or use the service only with valid authorization from a parent, guardian, school, or organization. Contact us if you believe a child provided personal information improperly.</p>

          <h2>11. Changes to this policy</h2>
          <p>We may update this policy as Planbraid, its integrations, or legal requirements change. We will post the revised version here and update the effective date. If a change materially affects how we use personal information, we will provide additional notice where required.</p>
        </section>

        <section id="contact" className={styles.contact}>
          <span className={styles.eyebrow}>PRIVACY CONTACT</span>
          <h2>12. Contact us</h2>
          <p>Questions, concerns, and requests concerning this policy or personal information should be directed to the Planbraid operator.</p>
          {contactEmail
            ? <a className={styles.contactButton} href={`mailto:${contactEmail}`}>{contactEmail}</a>
            : <div className={styles.contactFallback}><strong>Contact the Planbraid operator</strong><p>Use the support contact published in the Planbraid connected-app listing or your applicable service agreement. Please do not include passwords, access tokens, or other credentials in a privacy request.</p></div>}
          <p className={styles.contactMeta}>Service website: <a href="https://plan-braid.vercel.app/">https://plan-braid.vercel.app/</a></p>
        </section>

        <footer className={styles.footer}>
          <a href="/">Planbraid</a><span>Privacy Policy</span><span>Last updated {LAST_UPDATED}</span>
        </footer>
      </article>
    </div>
  </main>;
}
