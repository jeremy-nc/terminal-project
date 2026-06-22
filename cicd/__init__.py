"""CI/CD domain. Aggregates CI subdomains; today: TeamCity. A future provider
(e.g. GitHub Actions) would be another subdomain package alongside teamcity/."""
from .teamcity import TeamCityService

__all__ = ["TeamCityService"]
