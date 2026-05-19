import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Routes that require an authenticated Clerk session.
// /api/health stays public (liveness probe).
const isProtectedRoute = createRouteMatcher([
  "/api/me(.*)",
  "/api/onboarding(.*)",
  "/api/push(.*)",
  "/api/realtime(.*)",
  "/api/sessions(.*)",
  // Add new protected route prefixes here as we build them.
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and common static asset extensions.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
