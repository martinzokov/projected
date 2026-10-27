package com.acme;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.library.Architectures;

/**
 * Hexagonal boundary enforcement for the JVM, as an ordinary JUnit 5 test.
 * Verified against ArchUnit 1.4.1 on JDK 21.
 *
 * <p>Gradle:  testImplementation("com.tngtech.archunit:archunit-junit5:1.4.1")
 * <p>Maven:   com.tngtech.archunit:archunit-junit5:1.4.1 (scope test)
 *
 * <p>Layout:
 * <pre>
 *   com.acme.domain.{model,service,event,exception}
 *   com.acme.application.usecase
 *   com.acme.application.port.{driving,driven}
 *   com.acme.infrastructure.adapter.driving.&lt;name&gt;    web, messaging, ...
 *   com.acme.infrastructure.adapter.driven.&lt;name&gt;     persistence, payment, messaging, ...
 *   com.acme.infrastructure.config                    composition root
 * </pre>
 *
 * <p>ArchUnit is the strongest tier-1 option on any stack: it reads bytecode, so it
 * sees field types, method signatures, generics, annotations and reflection-free
 * usage — not just import statements. An {@code @Entity} annotation on a domain
 * class is caught here, where an import-based linter would need a deny-list.
 *
 * <p>IMPORTANT: {@code importPackages} must NOT include test classes, or the rules
 * will flag your own fixtures. {@code ImportOption.DoNotIncludeTests} is the
 * default for {@code @AnalyzeClasses} when you pass {@code packages}, but state it
 * explicitly if you customise the import.
 */
@AnalyzeClasses(packages = "com.acme")
public class HexagonalArchitectureTest {

    /**
     * The vertical rule plus adapter independence, in one primitive.
     *
     * <p>onionArchitecture() maps onto hexagonal directly: domainModels +
     * domainServices are the domain, applicationServices is the application layer
     * (use cases AND ports), and each adapter is registered separately. ArchUnit
     * enforces that adapters may not access each other — the rule that a purely
     * vertical layer check misses.
     *
     * <p>withOptionalLayers(false) makes an empty layer a failure rather than a
     * silent pass, so a typo'd package name cannot make this rule vacuous.
     */
    @ArchTest
    static final ArchRule hexagonal_layers = Architectures.onionArchitecture()
            .domainModels("com.acme.domain.model..")
            .domainServices(
                    "com.acme.domain.service..",
                    "com.acme.domain.event..",
                    "com.acme.domain.exception..")
            .applicationServices("com.acme.application..")
            .adapter("web", "com.acme.infrastructure.adapter.driving.web..")
            .adapter("consumer", "com.acme.infrastructure.adapter.driving.messaging..")
            .adapter("persistence", "com.acme.infrastructure.adapter.driven.persistence..")
            .adapter("payment", "com.acme.infrastructure.adapter.driven.payment..")
            .adapter("publisher", "com.acme.infrastructure.adapter.driven.messaging..")
            .withOptionalLayers(false)
            .ignoreDependency(
                    resideIn("com.acme.infrastructure.config.."), alwaysTrue())
            .as("Dependencies point inward, and adapters do not know each other");

    /**
     * onionArchitecture() treats the whole application package as one layer, so it
     * cannot see the driving/driven split. These four rules add it.
     */
    @ArchTest
    static final ArchRule ports_are_pure_interfaces =
            noClasses().that().resideInAPackage("..application.port..")
                    .should().dependOnClassesThat().resideInAPackage("..application.usecase..")
                    .as("A port must not depend on a use case — the use case implements the "
                            + "driving port, not the other way round");

    @ArchTest
    static final ArchRule driving_adapters_enter_through_driving_ports =
            noClasses().that().resideInAPackage("..infrastructure.adapter.driving..")
                    .should().dependOnClassesThat().resideInAnyPackage(
                            "..application.usecase..", "..application.port.driven..")
                    .as("A driving adapter enters through application.port.driving only");

    @ArchTest
    static final ArchRule driven_adapters_implement_driven_ports =
            noClasses().that().resideInAPackage("..infrastructure.adapter.driven..")
                    .should().dependOnClassesThat().resideInAnyPackage(
                            "..application.usecase..", "..application.port.driving..")
                    .as("A driven adapter implements application.port.driven and nothing else");

    @ArchTest
    static final ArchRule nothing_imports_the_composition_root =
            noClasses().that().resideOutsideOfPackage("..infrastructure.config..")
                    .should().dependOnClassesThat().resideInAPackage("..infrastructure.config..")
                    .as("Nothing may depend on the composition root");

    /**
     * Framework purity. This is where ArchUnit's bytecode view earns its keep: an
     * {@code @Entity} annotation, a JPA field type, or a Spring-injected
     * constructor parameter is a dependency here, whether or not it appears as an
     * import you thought to ban.
     */
    @ArchTest
    static final ArchRule domain_is_free_of_frameworks =
            noClasses().that().resideInAPackage("..domain..")
                    .should().dependOnClassesThat().resideInAnyPackage(
                            "javax.persistence..",
                            "jakarta.persistence..",
                            "org.springframework..",
                            "org.hibernate..",
                            "com.fasterxml.jackson..",
                            "javax.servlet..",
                            "jakarta.servlet..")
                    .as("The domain must not depend on a persistence, web or serialisation framework");

    @ArchTest
    static final ArchRule application_is_free_of_frameworks =
            noClasses().that().resideInAPackage("..application..")
                    .should().dependOnClassesThat().resideInAnyPackage(
                            "javax.persistence..",
                            "jakarta.persistence..",
                            "org.hibernate..",
                            "javax.servlet..",
                            "jakarta.servlet..",
                            "org.springframework.web..")
                    .as("Use cases and ports must not depend on persistence or web frameworks");

    // --- helpers for the ignoreDependency call above -------------------------

    private static com.tngtech.archunit.base.DescribedPredicate<com.tngtech.archunit.core.domain.JavaClass>
            resideIn(String packageIdentifier) {
        return com.tngtech.archunit.core.domain.JavaClass.Predicates
                .resideInAPackage(packageIdentifier);
    }

    private static com.tngtech.archunit.base.DescribedPredicate<com.tngtech.archunit.core.domain.JavaClass>
            alwaysTrue() {
        return com.tngtech.archunit.base.DescribedPredicate.alwaysTrue();
    }

    /** Kept so the unused-import checker does not strip JavaClasses. */
    @SuppressWarnings("unused")
    private JavaClasses unused;
}
