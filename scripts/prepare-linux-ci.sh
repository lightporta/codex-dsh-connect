#!/usr/bin/env bash
set -euo pipefail

# Configure only a disposable GitHub-hosted Linux runner. User workstations and
# self-hosted WSL runners must keep their own administrator-managed policies.
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_OS:-} != Linux || ${RUNNER_ENVIRONMENT:-} != github-hosted ]]; then
  echo 'This preparation is restricted to GitHub-hosted Linux runners.' >&2
  exit 64
fi
if [[ $(id -u) == 0 ]]; then
  echo 'Run as the ordinary runner user; the isolation probe must not run as root.' >&2
  exit 64
fi

sudo apt-get update
sudo apt-get install --yes bubblewrap apparmor-profiles apparmor-utils

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
probe_log=$(mktemp)
trap 'rm -f -- "$probe_log"' EXIT

# A working pre-existing policy needs no replacement. The same synthetic probe
# is run again by the following workflow step after any required preparation.
if node "$project_root/scripts/platform-isolation.mjs" >"$probe_log" 2>&1; then
  cat "$probe_log"
  echo 'Existing bubblewrap namespace policy works; no AppArmor policy changed.'
  exit 0
fi
cat "$probe_log" >&2
if ! grep -Eq 'bwrap: (loopback: Failed RTM_NEWADDR|setting up uid map|No permissions to create new namespace)' "$probe_log"; then
  echo 'The probe failed outside the known namespace-policy setup failure; refusing policy changes.' >&2
  exit 1
fi

restriction=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [[ ! -r $restriction || $(cat "$restriction") != 1 ]]; then
  echo 'The Ubuntu AppArmor user-namespace restriction is not active; inspect the original probe failure.' >&2
  exit 1
fi
original_restriction=$(cat "$restriction")
source_profile=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
target_profile=/etc/apparmor.d/bwrap-userns-restrict
if [[ ! -f $source_profile ]]; then
  echo 'The distribution-supplied bwrap-userns-restrict profile is unavailable.' >&2
  exit 1
fi
if [[ -e /etc/apparmor.d/bwrap || -e /etc/apparmor.d/disable/bwrap-userns-restrict || -L /etc/apparmor.d/disable/bwrap-userns-restrict ]]; then
  echo 'An existing or explicitly disabled bwrap policy needs administrator review.' >&2
  exit 1
fi
if [[ -e $target_profile || -L $target_profile ]]; then
  if ! cmp -s "$source_profile" "$target_profile"; then
    echo 'Refusing to overwrite a different existing bwrap AppArmor policy.' >&2
    exit 1
  fi
else
  sudo install -m 0644 "$source_profile" "$target_profile"
fi

# The distro profile grants setup capabilities to /usr/bin/bwrap, while its
# exec children stack unpriv_bwrap and lose capabilities. Do not disable the
# global userns restriction or share the host network for the offline probe.
sudo apparmor_parser -r "$target_profile"
if [[ $(cat "$restriction") != "$original_restriction" ]]; then
  echo 'The global AppArmor restriction changed unexpectedly.' >&2
  exit 1
fi
echo 'Loaded the distribution bwrap profile; the global AppArmor restriction remains enabled.'
