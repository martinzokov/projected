using NetArchTest.Rules;
using Xunit;

namespace Acme.App.ArchTests;

/// <summary>
/// Hexagonal boundary enforcement for .NET, as ordinary xUnit tests.
/// Verified against NetArchTest.Rules 1.3.2, xUnit 2.9.2, .NET 9.
///
/// <code>
///   dotnet add package NetArchTest.Rules
///   dotnet test
/// </code>
///
/// Layout (root namespace Acme.App):
///   Acme.App.Domain.{Model,Service,Event,Exception}
///   Acme.App.Application.UseCase
///   Acme.App.Application.Port.{Driving,Driven}
///   Acme.App.Infrastructure.Adapter.Driving.&lt;Name&gt;    Web, Messaging, ...
///   Acme.App.Infrastructure.Adapter.Driven.&lt;Name&gt;     Persistence, Payment, Messaging, ...
///   Acme.App.Infrastructure.Config                    composition root
///
/// Like ArchUnit, NetArchTest reads IL rather than source, so it sees field types,
/// constructor parameters, attributes and generic arguments — not just `using`
/// directives. An [Table]-attributed domain entity is caught here.
///
/// Tier 2 note: in .NET the idiomatic enforcement is one project per layer with
/// ProjectReference declared only where legal, which makes illegal references a
/// compile error. These tests then cover what project boundaries cannot express —
/// chiefly the driving/driven split inside a single Application project.
/// </summary>
public class HexagonalArchitectureTests
{
    private const string Root = "Acme.App";
    private const string Domain = Root + ".Domain";
    private const string Application = Root + ".Application";
    private const string UseCase = Application + ".UseCase";
    private const string PortDriving = Application + ".Port.Driving";
    private const string PortDriven = Application + ".Port.Driven";
    private const string Infrastructure = Root + ".Infrastructure";
    private const string AdapterDriving = Infrastructure + ".Adapter.Driving";
    private const string AdapterDriven = Infrastructure + ".Adapter.Driven";
    private const string Config = Infrastructure + ".Config";

    /// <summary>
    /// The assembly under test. Anchored on a type rather than a string so a
    /// rename breaks the build instead of silently emptying every rule.
    /// </summary>
    private static Types AppTypes =>
        Types.InAssembly(typeof(Domain.Model.Order).Assembly);

    // ------------------------------------------------------------ the layer rule

    [Fact]
    public void Domain_depends_on_nothing()
    {
        var result = AppTypes
            .That().ResideInNamespaceStartingWith(Domain)
            .ShouldNot().HaveDependencyOnAny(Application, Infrastructure)
            .GetResult();

        AssertArchitecture(result,
            "Domain must not depend on application or infrastructure. Dependencies "
            + "point inward: declare a driven port instead.");
    }

    [Fact]
    public void Application_does_not_depend_on_infrastructure()
    {
        var result = AppTypes
            .That().ResideInNamespaceStartingWith(Application)
            .ShouldNot().HaveDependencyOn(Infrastructure)
            .GetResult();

        AssertArchitecture(result,
            "Application must not depend on infrastructure. Declare a port in "
            + "Application.Port.Driven and let the adapter implement it.");
    }

    // -------------------------------------------------- driving / driven split

    [Fact]
    public void Ports_are_pure_interfaces()
    {
        var result = AppTypes
            .That().ResideInNamespaceStartingWith(Application + ".Port")
            .ShouldNot().HaveDependencyOn(UseCase)
            .GetResult();

        AssertArchitecture(result,
            "A port must not depend on a use case — the use case implements the "
            + "driving port, not the other way round.");
    }

    [Fact]
    public void Driving_adapters_enter_through_driving_ports()
    {
        var result = AppTypes
            .That().ResideInNamespaceStartingWith(AdapterDriving)
            .ShouldNot().HaveDependencyOnAny(UseCase, PortDriven)
            .GetResult();

        AssertArchitecture(result,
            "A driving adapter enters the application through Application.Port.Driving "
            + "only. Depending on the use case type welds the transport to the "
            + "implementation; depending on a driven port is upside down.");
    }

    [Fact]
    public void Driven_adapters_implement_driven_ports()
    {
        var result = AppTypes
            .That().ResideInNamespaceStartingWith(AdapterDriven)
            .ShouldNot().HaveDependencyOnAny(UseCase, PortDriving)
            .GetResult();

        AssertArchitecture(result,
            "A driven adapter implements Application.Port.Driven and nothing else. "
            + "Depending on a use case is a cycle in disguise.");
    }

    // ------------------------------------------------------ adapter independence
    //
    // NetArchTest has no back-references either, so each adapter names its
    // siblings. Keep one fact per adapter so a failure says which one.

    [Theory]
    [InlineData(AdapterDriving + ".Web", AdapterDriving + ".Messaging", AdapterDriven)]
    [InlineData(AdapterDriving + ".Messaging", AdapterDriving + ".Web", AdapterDriven)]
    [InlineData(AdapterDriven + ".Persistence", AdapterDriven + ".Payment", AdapterDriving)]
    [InlineData(AdapterDriven + ".Payment", AdapterDriven + ".Persistence", AdapterDriving)]
    [InlineData(AdapterDriven + ".Messaging", AdapterDriven + ".Persistence", AdapterDriving)]
    public void Adapters_do_not_know_each_other(string adapter, params string[] forbidden)
    {
        var result = AppTypes
            .That().ResideInNamespaceStartingWith(adapter)
            .ShouldNot().HaveDependencyOnAny(forbidden)
            .GetResult();

        AssertArchitecture(result,
            $"{adapter} must not depend on another adapter. Route the call through a "
            + "use case, or through a port both adapters know. Shared helpers belong "
            + "to neither — extract or duplicate them.");
    }

    // -------------------------------------------------------- composition root

    [Fact]
    public void Nothing_depends_on_the_composition_root()
    {
        var result = AppTypes
            .That().DoNotResideInNamespaceStartingWith(Config)
            .ShouldNot().HaveDependencyOn(Config)
            .GetResult();

        AssertArchitecture(result,
            "Nothing may depend on the composition root. Config wires the application "
            + "together; take the value as a parameter instead.");
    }

    // ------------------------------------------------------------ framework purity

    [Fact]
    public void Domain_is_free_of_frameworks()
    {
        var result = AppTypes
            .That().ResideInNamespaceStartingWith(Domain)
            .ShouldNot().HaveDependencyOnAny(
                "Microsoft.EntityFrameworkCore",
                "System.Data",
                "Microsoft.AspNetCore",
                "Dapper",
                "Npgsql",
                "StackExchange.Redis",
                "Confluent.Kafka")
            .GetResult();

        AssertArchitecture(result,
            "The domain must not depend on a persistence or transport framework. An EF "
            + "attribute on an entity is an outward dependency just like an import.");
    }

    /// <summary>
    /// NetArchTest returns an empty FailingTypes list on success; on failure it
    /// names every offending type. Surfacing those names is what makes the failure
    /// actionable rather than just red.
    /// </summary>
    private static void AssertArchitecture(TestResult result, string because)
    {
        var offenders = result.FailingTypeNames is null
            ? string.Empty
            : string.Join("\n  - ", result.FailingTypeNames);

        Assert.True(result.IsSuccessful, $"{because}\nOffending types:\n  - {offenders}");
    }
}
