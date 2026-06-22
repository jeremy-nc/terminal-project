import React from "react";
import TeamCityPanel from "./TeamCityPanel.jsx";

/** CI/CD domain shell. Hosts one panel per CI provider; today just TeamCity. A
 *  future provider (e.g. GitHub Actions) would be another panel alongside it —
 *  the domain owns the layout, each subdomain owns its panel. */
export default function CICDDashboard({ cicd, teamcityProjectBuilds = {} }) {
  return (
    <div className="cicd-domain">
      <TeamCityPanel teamcity={cicd?.teamcity || {}} projectBuilds={teamcityProjectBuilds} />
    </div>
  );
}
