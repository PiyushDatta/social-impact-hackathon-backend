import os
import webbrowser
import requests
import time
from requests.exceptions import RequestException

BASE_URL = os.getenv("BASE_URL", "http://localhost:8080")

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

    return auth_url


def open_browser_for_login(url):
    print_header("3. Launching browser — complete Google login manually")

    print(
        f"{YELLOW}Complete the Google login in your browser.\n"
        f"After you see 'auth=success' in the URL or a success message,\n"
        f"press ENTER here to continue.{RESET}"
    )

    webbrowser.open(url)
    input("\nPress ENTER after completing Google login... ")


def test_session(session):
    print_header("4. Testing authenticated session (/auth/me)...")

    try:
        r = session.get(f"{BASE_URL}/auth/me")
    except Exception as e:
        print(f"{RED}Failed to call /auth/me: {e}{RESET}")
        return False

    if r.status_code == 200:
        print(f"{GREEN}Authenticated session works ✓{RESET}")
        print(f"{CYAN}User info:{RESET} {r.json()}")
        return True
    else:
        print(f"{RED}Session invalid — status {r.status_code}{RESET}")
        print(f"{RED}Response: {r.text}{RESET}")
        return False


def main():
    print_header("Google OAuth Login Test")

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

    # Test 3: Open browser
    open_browser_for_login(google_url)

    # Wait for session to be established
    time.sleep(3)

    # Test 4: Check authentication
    success = test_session(session)

    print_header("Test Complete")
    if success:
        print(f"{GREEN}✓ OAuth flow is fully working!{RESET}")
    else:
        print(f"{RED}✗ OAuth flow failed. Check errors above.{RESET}")


if __name__ == "__main__":
    main()
