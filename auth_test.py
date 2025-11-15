import os
import webbrowser
import requests
import time
from urllib.parse import urlparse, parse_qs
from requests.exceptions import RequestException

# Use your Cloud Run URL
BASE_URL = os.getenv(
    "BASE_URL", "https://social-impact-hackathon-backend-719737115197.us-west2.run.app"
)

# Colors
GREEN = "\033[92m"
RED = "\033[91m"
CYAN = "\033[96m"
YELLOW = "\033[93m"
RESET = "\033[0m"


def print_header(title):
    print(f"\n{CYAN}{'='*60}\n{title}\n{'='*60}{RESET}")


def test_backend_ready():
    print_header("1. Checking backend health...")

    try:
        # Use health check endpoint
        r = requests.get(f"{BASE_URL}/health", timeout=5)
        if r.status_code == 200:
            print(f"{GREEN}Backend is reachable ✓{RESET}")
            print(f"{CYAN}Response: {r.json()}{RESET}")
            return True
        else:
            print(f"{RED}Unexpected status: {r.status_code}{RESET}")
            print(f"{RED}Response: {r.text}{RESET}")
            return False
    except RequestException as e:
        print(f"{RED}Backend not reachable: {e}{RESET}")
        return False


def extract_google_url():
    print_header("2. Requesting Google OAuth login URL...")

    try:
        r = requests.get(f"{BASE_URL}/auth/google/url", timeout=10)
    except Exception as e:
        print(f"{RED}Request failed: {e}{RESET}")
        return None

    if r.status_code != 200:
        print(f"{RED}Bad status: {r.status_code}{RESET}")
        print(f"{RED}Response: {r.text}{RESET}")
        return None

    try:
        data = r.json()
    except Exception as e:
        print(f"{RED}Invalid JSON: {e}{RESET}")
        print(f"{RED}Raw: {r.text}{RESET}")
        return None

    auth_url = data.get("authUrl")
    if not auth_url:
        print(f"{RED}No authUrl in response{RESET}")
        print(f"{RED}Data: {data}{RESET}")
        return None

    print(f"{GREEN}Received Google OAuth URL ✓{RESET}")
    print(f"{YELLOW}{auth_url}{RESET}")

    # Validate the URL
    parsed = urlparse(auth_url)
    params = parse_qs(parsed.query)

    print(f"\n{CYAN}OAuth URL Parameters:{RESET}")
    print(f"  Client ID: {params.get('client_id', ['MISSING'])[0][:20]}...")
    print(f"  Redirect URI: {params.get('redirect_uri', ['MISSING'])[0]}")
    print(f"  Scope: {params.get('scope', ['MISSING'])[0]}")

    return auth_url


def open_browser_for_login(url):
    print_header("3. Launching browser — complete Google login manually")

    print(
        f"{YELLOW}Complete the Google login in your browser.\n"
        f"After redirect, copy the FULL URL from your browser and paste it here.{RESET}"
    )

    webbrowser.open(url)
    callback_url = input("\nPaste the full callback URL here: ").strip()

    return callback_url


def parse_callback_url(callback_url):
    print_header("4. Parsing callback URL...")

    try:
        parsed = urlparse(callback_url)
        params = parse_qs(parsed.query)

        # Check for error
        if "auth" in params and params["auth"][0] == "error":
            error_msg = params.get("message", ["Unknown error"])[0]
            print(f"{RED}Authentication failed: {error_msg}{RESET}")
            return None

        # Check for success with user data
        if "user" in params:
            import json
            from urllib.parse import unquote

            user_data = json.loads(unquote(params["user"][0]))
            profile_data = (
                json.loads(unquote(params["profile"][0]))
                if "profile" in params
                else None
            )

            print(f"{GREEN}Successfully extracted user data ✓{RESET}")
            print(f"\n{CYAN}User Data:{RESET}")
            print(f"  UID: {user_data.get('uid')}")
            print(f"  Email: {user_data.get('email')}")
            print(f"  Name: {user_data.get('name')}")

            if profile_data:
                print(f"\n{CYAN}Profile Data:{RESET}")
                print(f"  {profile_data}")

            return {"user": user_data, "profile": profile_data}

        # Check for session-based success (old method)
        if "auth" in params and params["auth"][0] == "success":
            print(f"{GREEN}OAuth callback received (session-based) ✓{RESET}")
            return {"session_based": True}

        print(f"{RED}Unexpected callback format{RESET}")
        print(f"{RED}URL: {callback_url}{RESET}")
        return None

    except Exception as e:
        print(f"{RED}Failed to parse callback: {e}{RESET}")
        return None


def test_session(session):
    print_header("5. Testing authenticated session (/auth/me)...")

    try:
        r = session.get(f"{BASE_URL}/auth/me", timeout=10)
    except Exception as e:
        print(f"{RED}Failed to call /auth/me: {e}{RESET}")
        return False

    if r.status_code == 200:
        data = r.json()
        if data.get("authenticated"):
            print(f"{GREEN}Authenticated session works ✓{RESET}")
            print(f"{CYAN}User info:{RESET} {data}")
            return True
        else:
            print(f"{YELLOW}Not authenticated (expected for mobile flow){RESET}")
            return False
    else:
        print(
            f"{YELLOW}Session check returned {r.status_code} (expected for mobile flow){RESET}"
        )
        return False


def main():
    print_header("Google OAuth Login Test")
    print(f"{CYAN}Testing backend: {BASE_URL}{RESET}")

    # Test 1: Backend health
    if not test_backend_ready():
        print(f"{RED}Backend not ready. Exiting.{RESET}")
        return

    # Create session to persist cookies
    session = requests.Session()

    # Test 2: Get auth URL
    google_url = extract_google_url()
    if not google_url:
        print(f"{RED}Failed to get auth URL. Exiting.{RESET}")
        return

    # Test 3: Open browser and get callback URL
    callback_url = open_browser_for_login(google_url)

    if not callback_url:
        print(f"{RED}No callback URL provided. Exiting.{RESET}")
        return

    # Test 4: Parse callback
    result = parse_callback_url(callback_url)

    if not result:
        print(f"{RED}Failed to parse callback. Exiting.{RESET}")
        return

    # Test 5: Check session (optional, won't work for mobile flow)
    if result.get("session_based"):
        time.sleep(2)
        test_session(session)

    print_header("Test Complete")

    if result and "user" in result:
        print(
            f"{GREEN}✓ OAuth flow is working! User data extracted successfully.{RESET}"
        )
        print(
            f"{CYAN}This is the mobile flow - user data is passed in URL parameters.{RESET}"
        )
    elif result and result.get("session_based"):
        print(f"{GREEN}✓ OAuth flow is working (session-based).{RESET}")
        print(
            f"{YELLOW}Note: For mobile apps, you need to pass user data in URL.{RESET}"
        )
    else:
        print(f"{RED}✗ OAuth flow failed. Check errors above.{RESET}")


if __name__ == "__main__":
    main()
